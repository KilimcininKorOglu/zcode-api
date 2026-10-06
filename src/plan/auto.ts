/**
 * Hybrid plan auto-switch — prefer the start-plan (trial) entitlement while it
 * has balance and fall back to the coding plan when it runs out.
 *
 * Two mechanisms, mirroring existing repo patterns:
 *  - A background watcher (`startPlanAutoWatcher`, ClaimScheduler skeleton in
 *    ../claim/scheduler.ts) polls `billing/balance` every few minutes and
 *    updates the effective plan.
 *  - A per-request fallback seam (`retryOnPlanExhausted`, callback shape of
 *    retryOnCaptchaChallenge in ../proxy/captcha-retry.ts): when the start-plan
 *    gateway rejects a request with 401/402/403, the caller retries the SAME
 *    request once on the coding plan; a cooldown then keeps traffic on the
 *    coding plan until the watcher sees balance again.
 *
 * Handlers resolve the plan ONCE per request via `activePlan` — never read
 * `config.plan` mid-request, the watcher may flip it between rebuilds.
 *
 * Module-level state follows the `getDefaultEndpointRouting`/
 * `getDefaultClientSigning` singleton pattern; `__resetPlanAutoStateForTests`
 * restores a clean slate in tests.
 */
import type { ProxyConfig } from "../config/types.js";
import { fetchStartPlanBalance, type QuotaBalanceEntry } from "../server/routes-quota.js";

export type PlanTier = "coding-plan" | "start-plan";

/** Balance poll cadence — same default as the claim scheduler (5 min). */
export const PLAN_POLL_INTERVAL_MS = 300_000;
/** Stay on the coding plan after a fallback until the watcher sees balance. */
export const PLAN_FALLBACK_COOLDOWN_MS = 600_000;
/** Epoch values above this are milliseconds; upstream mixes seconds and ms in the wild. */
const EPOCH_MS_THRESHOLD = 1e12;

interface PlanAutoState {
  /** Effective plan; null = no balance data yet → optimistically start-plan. */
  effective: PlanTier | null;
  fallbackCooldownUntil: number;
  lastCheckAt: number;
  lastError: string | null;
}

const state: PlanAutoState = {
  effective: null,
  fallbackCooldownUntil: 0,
  lastCheckAt: 0,
  lastError: null,
};

/**
 * Plan a request should use. With `planAutoSwitch` off this is exactly
 * `config.plan`; with it on: the watcher's effective plan wins; before the
 * first balance probe lands, start-plan is assumed. Either way, a start-plan
 * request the gateway rejects falls back to the coding plan for that request
 * (see shouldFallbackPlan).
 */
export function activePlan(config: ProxyConfig): PlanTier {
  if (config.planAutoSwitch !== true) return config.plan;
  if (state.effective) return state.effective;
  if (Date.now() < state.fallbackCooldownUntil) return "coding-plan";
  return "start-plan";
}

/**
 * True when the upstream status on a start-plan request should trigger the
 * one-shot coding-plan fallback. Runs regardless of `planAutoSwitch`: the
 * fallback repairs a rejected plan within one request, whether the plan was
 * picked by the watcher or by hand (live 2026-10-06: flag off, start-plan
 * hand-pinned, gateway answered 200 + {"code":1005,"msg":"exceed quota
 * limit"} and the envelope passed through until the operator restarted).
 * 401/402/403: the gateway rejected the plan (bad JWT / no balance).
 * 502/504: the start-plan gateway itself is failing (observed live
 * 2026-10-04 as sustained 504@60s/502@30s stretches). 429: on THIS gateway
 * it is the exhaustion signal, not a load signal (observed live 2026-10-05
 * as seven consecutive 429s with no cooldown escape, because the auto-claim
 * scheduler kept refreshing trial balances while every request was
 * rejected). Other 5xx stay put: generic load/failure signals, not plan
 * failures.
 */
export function shouldFallbackPlan(status: number, plan: PlanTier): boolean {
  if (plan !== "start-plan") return false;
  return status === 401 || status === 402 || status === 403 || status === 429 || status === 502 || status === 504;
}

/** JSON error envelopes larger than this are treated as real payloads, not errors. */
const SNIFF_CAP_BYTES = 65536;

/**
 * The start-plan gateway can exhaust a plan with HTTP 200 + a JSON error
 * envelope instead of an error status (observed live 2026-10-03: 200 +
 * non-Anthropic JSON body, Claude Code saw "0 stream events"). Sniff small
 * JSON responses for such an envelope before trusting them. SSE responses
 * and non-JSON bodies pass through untouched; a non-error JSON body comes
 * back buffered so the caller can still serve it.
 *
 * Envelope criteria mirror the billing gateway's (`isSuccessfulEnvelope` in
 * routes-quota.ts): `success === false`, or a numeric `code` outside
 * {0, 200}. Code 3007 is excluded — that is a captcha challenge, owned by
 * the captcha retry seam.
 */
export async function sniffStartPlanRejection(resp: Response): Promise<{ rejected: boolean; response: Response }> {
  const contentType = resp.headers.get("content-type") ?? "";
  const passthrough = { rejected: false, response: resp };
  if (!contentType.includes("json")) return passthrough;
  const text = await resp.text();
  const buffered = { status: resp.status, statusText: resp.statusText, headers: resp.headers };
  if (text.length > SNIFF_CAP_BYTES) return { rejected: false, response: new Response(text, buffered) };
  let body: { code?: unknown; success?: unknown };
  try {
    body = JSON.parse(text) as { code?: unknown; success?: unknown };
  } catch {
    return { rejected: false, response: new Response(text, buffered) };
  }
  const numericCode = typeof body.code === "number" ? body.code : undefined;
  const rejected = body.success === false
    || (numericCode !== undefined && numericCode !== 0 && numericCode !== 200 && numericCode !== 3007);
  return { rejected, response: new Response(text, buffered) };
}

/** Record a fallback: cool down start-plan and pin the effective plan to coding-plan until the watcher reassesses. */
export function notePlanFallback(onSwitch?: (message: string) => void): void {
  state.fallbackCooldownUntil = Date.now() + PLAN_FALLBACK_COOLDOWN_MS;
  setEffective("coding-plan", `upstream rejected start-plan — cooldown ${Math.round(PLAN_FALLBACK_COOLDOWN_MS / 60_000)}min`, onSwitch);
}

export interface PlanFallbackOutcome {
  handled: boolean;
  /** The coding-plan retry's response; present when `handled` is true. */
  resp?: Response;
}

/**
 * Per-request fallback seam (callback shape mirrors retryOnCaptchaChallenge):
 * when the start-plan gateway rejected the request (error status OR a 200
 * JSON error envelope, both detected by the caller), run the caller's
 * coding-plan rebuild + dispatch ONCE and record the cooldown first so
 * concurrent requests skip the broken plan. Runs regardless of
 * `planAutoSwitch`. `rebuildAndDispatch` errors propagate to the caller,
 * which maps them onto its own 502 path.
 */
export async function retryOnPlanExhausted(args: {
  rejected: boolean;
  plan: PlanTier;
  rebuildAndDispatch: () => Promise<Response>;
  onFallback?: (message: string) => void;
}): Promise<PlanFallbackOutcome> {
  if (!args.rejected) return { handled: false };
  if (args.plan !== "start-plan") return { handled: false };
  notePlanFallback(args.onFallback);
  const resp = await args.rebuildAndDispatch();
  return { handled: true, resp };
}

function setEffective(next: PlanTier, reason: string, onSwitch?: (message: string) => void): void {
  if (state.effective === next) return;
  state.effective = next;
  const message = `plan auto-switch: active plan is now ${next} (${reason})`;
  (onSwitch ?? ((m: string) => console.log(m)))(message);
}

/** True when at least one balance bucket has remaining units and has not expired. */
export function hasUsableBalance(entries: QuotaBalanceEntry[], nowMs: number = Date.now()): boolean {
  return entries.some((e) => {
    if (!(e.remainingUnits > 0)) return false;
    if (e.expiresAt === undefined) return true;
    const expiresMs = e.expiresAt > EPOCH_MS_THRESHOLD ? e.expiresAt : e.expiresAt * 1000;
    return expiresMs > nowMs;
  });
}

export interface PlanAutoWatcher {
  stop(): void;
  /** One balance probe → effective-plan update. Exposed for tests. */
  tick(): Promise<void>;
}

export interface PlanAutoWatcherDeps {
  fetchImpl?: typeof fetch;
  loadCredentialImpl?: Parameters<typeof fetchStartPlanBalance>[2];
}

/**
 * Start the background balance watcher. The first probe runs immediately so
 * the optimistic start-plan assumption is corrected within one request; later
 * probes run on a fixed interval. Stop it on shutdown like the claim
 * scheduler (uncleared timers keep the process alive).
 */
export function startPlanAutoWatcher(config: ProxyConfig, deps: PlanAutoWatcherDeps = {}): PlanAutoWatcher {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher: PlanAutoWatcher = {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async tick(): Promise<void> {
      if (stopped) return;
      state.lastCheckAt = Date.now();
      let result: Awaited<ReturnType<typeof fetchStartPlanBalance>>;
      try {
        result = await fetchStartPlanBalance(config, deps.fetchImpl, deps.loadCredentialImpl);
      } catch (err) {
        state.lastError = (err as Error).message;
        return;
      }
      if (result === null) {
        // No plan JWT (login pending, e.g. Android before first login) — stay
        // on config.plan semantics and retry on the next tick.
        state.lastError = "no plan JWT (login pending)";
        return;
      }
      if (!result.ok) {
        state.lastError = result.error ?? "balance probe failed";
        return;
      }
      state.lastError = null;
      const has = hasUsableBalance(result.balances);
      // During the fallback cooldown the gateway's balance may still report
      // credit while requests are actually rejected — hold coding-plan until
      // the cooldown lapses so the two plans do not flap.
      const cooling = Date.now() < state.fallbackCooldownUntil;
      const goStart = has && !cooling;
      if (goStart) state.fallbackCooldownUntil = 0;
      setEffective(
        goStart ? "start-plan" : "coding-plan",
        goStart
          ? "start-plan balance available"
          : has
            ? "start-plan balance available but fallback cooldown active"
            : "start-plan balance empty or expired",
      );
    },
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void watcher.tick().finally(scheduleNext);
    }, PLAN_POLL_INTERVAL_MS);
  };
  void watcher.tick().finally(scheduleNext);
  return watcher;
}

/** Restore pristine module state in tests. */
export function __resetPlanAutoStateForTests(): void {
  state.effective = null;
  state.fallbackCooldownUntil = 0;
  state.lastCheckAt = 0;
  state.lastError = null;
}

/** Place the fallback cooldown at an absolute time (tests only). */
export function __setFallbackCooldownForTests(until: number): void {
  state.fallbackCooldownUntil = until;
}
