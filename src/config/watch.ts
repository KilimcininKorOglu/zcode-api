/**
 * Hot reload for config.yaml (fs.watch + short debounce).
 *
 * Restarting the proxy to flip `plan` or `claim.auto` kills every in-flight
 * stream, and a truncated SSE surfaces client-side as a decode error rather
 * than a clean connection error. The watcher reloads the file instead and
 * applies the change IN PLACE on the shared config object: every route reads
 * `config` per request (plan, provider, proxyApiKey, batchAsStream, models,
 * identity, ...), so an in-place swap is visible on the very next request.
 * The one startup-bound group (`server`: port/host) cannot move without
 * re-binding the listener — it is reported as restart-required, never applied.
 *
 * Start/stop-on-config jobs (claim scheduler, plan auto-switch watcher,
 * captcha pool warmup) are reconciled through `ConfigWatchHandles` after each
 * applied reload, so flipping them in the file starts or stops the job.
 *
 * Failure mode: a reload that throws (broken YAML, missing file) keeps the
 * running config and stays watching — the next save can still succeed.
 */
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { loadConfig } from "./loader.js";
import type { ProxyConfig } from "./types.js";

/** Fields bound once at startup — reported back as "restart to apply". */
const RESTART_ONLY_KEYS = new Set(["server"]);

/** Lifecycle seams for the jobs serve() starts and stops from config state. */
export interface ConfigWatchHandles {
  /** Running-or-starting state of the claim scheduler (guards async import). */
  claimRunning(): boolean;
  startClaim(): void;
  stopClaim(): void;
  planWatcherRunning(): boolean;
  startPlanWatcher(): void;
  stopPlanWatcher(): void;
  /** Warm the captcha pool when the config moves to start-plan (no-op once up). */
  warmCaptchaPool(): void;
}

export interface ConfigWatcher {
  stop(): void;
}

/**
 * Watch `path`'s directory and re-apply the config on every real change.
 * The DIRECTORY is watched, not the file: editors and atomic writes replace
 * the file by rename, which would leave a file watcher on a dead inode.
 */
export function watchConfigFile(
  path: string,
  current: ProxyConfig,
  handles: ConfigWatchHandles,
  debounceMs = 300,
): ConfigWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const watcher = watch(dirname(path), (_event, filename) => {
    if (closed) return;
    if (filename && filename !== basename(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(applyReload, debounceMs);
  });

  function applyReload(): void {
    timer = null;
    if (closed) return;
    let next: ProxyConfig;
    try {
      next = loadConfig(path);
    } catch (err) {
      console.error(`[config] reload failed, keeping the running config: ${(err as Error).message}`);
      return;
    }
    const changed = new Set<string>();
    const restartNeeded: string[] = [];
    for (const key of Object.keys(next) as (keyof ProxyConfig)[]) {
      if (stableEqual(next[key], current[key])) continue;
      if (RESTART_ONLY_KEYS.has(key)) {
        restartNeeded.push(`${String(key)} (restart to apply)`);
        continue;
      }
      Object.assign(current, { [key]: next[key] });
      changed.add(String(key));
    }
    if (changed.size === 0 && restartNeeded.length === 0) return; // self-write or touch
    reconcileJobs(handles, current, changed);
    console.log(`[config] reloaded: ${[...changed].join(", ")}${restartNeeded.length > 0 ? `; ${restartNeeded.join(", ")}` : ""}`);
  }

  return {
    stop() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Bring the start/stop-on-config jobs in line with the freshly applied
 * config. A dirty `claim` block restarts the scheduler even when it keeps
 * running, so pollIntervalMs / cooldownMs changes reach the running job.
 */
function reconcileJobs(handles: ConfigWatchHandles, config: ProxyConfig, changed: Set<string>): void {
  const wantClaim = config.claim.enabled && config.claim.auto;
  if (wantClaim && (changed.has("claim") || !handles.claimRunning())) handles.startClaim();
  if (!wantClaim && handles.claimRunning()) handles.stopClaim();

  const wantPlanWatcher = config.planAutoSwitch === true;
  if (wantPlanWatcher && !handles.planWatcherRunning()) handles.startPlanWatcher();
  if (!wantPlanWatcher && handles.planWatcherRunning()) handles.stopPlanWatcher();

  if (config.plan === "start-plan") handles.warmCaptchaPool();
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
