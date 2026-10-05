/**
 * Persistent error log — every error the proxy returns (and the upstream
 * failure events on the way) is appended as one self-contained JSONL line, so
 * failures can be reviewed after the fact instead of scroll-back through
 * stdout. Lives next to the config file: in the compose image that is
 * /data/errors.log, i.e. the host's docker-data/errors.log.
 *
 * File resolution (first match wins):
 *   1. `ZCODE_ERROR_LOG` env — explicit file path
 *   2. the directory of `ZCODE_PROXY_CONFIG` (set to /data/config.yaml by the
 *      compose image, so the file lands on the bind-mounted data volume)
 *   3. `~/.zcode-proxy/errors.log`
 *
 * Design constraints (mirrors dump.ts):
 * - Must NEVER affect request handling — all FS work is try/catch'd; a broken
 *   log destination disables the file (one console.warn) but never the proxy.
 * - Under bun:test the logger is a no-op unless `ZCODE_ERROR_LOG` points at a
 *   temp file, so test runs never pollute the operator's real log.
 * - Simple size rotation: past `MAX_BYTES` the file becomes `errors.log.1`
 *   (single generation, overwritten) so the data dir cannot grow unbounded.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

let cachedPath: string | null = null;
let disabled = false;

/** Resolve (and memoize) the error-log file path. */
export function errorLogPath(): string {
  if (cachedPath) return cachedPath;
  const explicit = process.env.ZCODE_ERROR_LOG;
  if (explicit) {
    cachedPath = explicit;
    return cachedPath;
  }
  const configPath = process.env.ZCODE_PROXY_CONFIG;
  if (configPath) {
    cachedPath = join(dirname(configPath), "errors.log");
    return cachedPath;
  }
  cachedPath = join(homedir(), ".zcode-proxy", "errors.log");
  return cachedPath;
}

/** Append one error entry as a JSONL line. Never throws. */
export function appendErrorLog(entry: Record<string, unknown>): void {
  if (disabled) return;
  if (process.env.NODE_ENV === "test" && !process.env.ZCODE_ERROR_LOG) return;
  const path = errorLogPath();
  try {
    rotateErrorLogIfNeeded(path, MAX_BYTES);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(path, line + "\n");
  } catch (err) {
    disabled = true;
    console.warn(`[proxy] error log disabled (cannot write ${path}): ${(err as Error).message}`);
  }
}

/** Move an oversized log aside (single generation: errors.log.1 is overwritten). */
export function rotateErrorLogIfNeeded(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch {
    // missing file — first write
  }
}

/** Test hook: clear the memoized path and the disabled flag. */
export function __resetErrorLogForTests(): void {
  cachedPath = null;
  disabled = false;
}
