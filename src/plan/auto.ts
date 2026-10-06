/**
 * Configurable plan auto-switch — the watcher keeps traffic on the first plan
 * in `config.planPriority` whose watched signals still have quota.
 *
 * Signals per plan (config.planSwitchRules, default = every known one):
 *  - start-plan: BALANCE — the trial credits plane (`billing/balance`).
 *  - coding-plan: TIME_LIMIT / WEEK_LIMIT — the monitor-plane usage windows.
 *
 * Two mechanisms, mirroring existing repo patterns:
 *  - A background watcher (`startPlanAutoWatcher`, ClaimScheduler skeleton in
 *    ../claim/scheduler.ts) polls both planes and updates the effective plan.
 *  - A per-request fallback seam (`retryOnPlanExhausted`, callback shape of
 *    retryOnCaptchaChallenge in ../proxy/captcha-retry.ts): when the serving
 *    plan rejects a request, the caller retries the SAME request once on the
 *    next plan in the priority list; a cooldown then holds traffic there until
 *    the watcher reassesses. Runs regardless of `planAutoSwitch`.
 *
 * Handlers resolve the plan ONCE per request via `activePlan` — never read
 * `config.plan` mid-request, the watcher may flip it between rebuilds.
 *
 * Module-level state follows the `getDefaultEndpointRouting`/
 * `getDefaultClientSigning` singleton pattern; `__resetPlanAutoStateForTests`
 * restores a clean slate in tests.
 */
import {
  DEFAULT_PLAN_POLL_INTERVAL_SEC,
  DEFAULT_PLAN_PRIORITY,
  DEFAULT_PLAN_SWITCH_RULES,
  type PlanTier,
  type ProxyConfig,
} from "../config/types.js";
import {
  fetchCodingPlanUsage,
  fetchStartPlanBalance,
  type QuotaBalanceEntry,
  type QuotaCodingLimit,
} from "../server/routes-quota.js";

/** Re-exported for the handlers importing the plan seam from here. */
export type { PlanTier };

/** Stay on the fallback plan after a rejection until the watcher reassesses. */
export const PLAN_FALLBACK_COOLDOWN_MS = 600_000;
/** Epoch values above this are milliseconds; upstream mixes seconds and ms in the wild. */
const EPOCH_MS_THRESHOLD = 1e12;

interface PlanAutoState {
  /** Effective plan; null = no poll data yet → optimistically priority[0]. */
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

/** Config accessor: the priority list (default mirrors today's behavior). */
export function planPriorityOf(config: ProxyConfig): PlanTier[] {
  return config.planPriority ?? DEFAULT_PLAN_PRIORITY;
}

/** Config accessor: the watched signals of one plan (default = all known). */
export function planWatchedLimitsOf(config: ProxyConfig, plan: PlanTier): string[] {
  return config.planSwitchRules?.[plan]?.limits ?? DEFAULT_PLAN_SWITCH_RULES[plan].limits;
}

/** Config accessor: the watcher poll cadence in ms. */
export function planPollIntervalMsOf(config: ProxyConfig): number {
  return (config.planPollIntervalSec ?? DEFAULT_PLAN_POLL_INTERVAL_SEC) * 1000;
}

/** The next plan after `plan` in the priority list; null when plan is last or unlisted. */
export function nextPlanInPriority(priority: PlanTier[], plan: PlanTier): PlanTier | null {
  const at = priority.indexOf(plan);
  if (at < 0 || at >= priority.length - 1) return null;
  return priority[at + 1];
}

/**
 * Plan a request should use. With `planAutoSwitch` off this is exactly
 * `config.plan`; with it on: the watcher's effective plan wins; before the
 * first poll lands, priority[0] is assumed (a cooldown-active fallback target
 * when the request repair just happened). Either way, a rejected request
 * falls to the next plan for that request (see shouldFallbackPlan).
 */
export function activePlan(config: ProxyConfig): PlanTier {
  if (config.planAutoSwitch !== true) return config.plan;
  if (state.effective) return state.effective;
  const priority = planPriorityOf(config);
  if (Date.now() < state.fallbackCooldownUntil) {
    return nextPlanInPriority(priority, priority[0]) ?? priority[0];
  }
  return priority[0];
}

/**
 * True when the upstream status on a plan request should trigger the one-shot
 * next-plan fallback. Runs regardless of `planAutoSwitch`: the fallback
 * repairs a rejected plan within one request, whether the plan was picked by
 * the watcher or by hand (live 2026-10-06: flag off, start-plan hand-pinned,
 * gateway answered 200 + {"code":1005,"msg":"exceed quota limit"} and the
 * envelope passed through until the operator restarted).
 *
 * start-plan: 401/402/403 = the gateway rejected the plan (bad JWT / no
 * balance); 502/504 = the start-plan gateway itself is failing (observed live
 * 2026-10-04 as sustained 504@60s/502@30s stretches); 429 = on THIS gateway
 * the exhaustion signal, not load (observed live 2026-10-05 as seven
 * consecutive 429s with no cooldown escape). Other 5xx stay put: generic
 * load/failure signals, not plan failures.
 *
 * coding-plan: 429 is the limit-exhaustion signal (the watched TIME_LIMIT /
 * WEEK_LIMIT windows hitting zero surface as 429s from the ultra gateway);
 * 502/504 are absorbed by the dispatch-level gateway retry and 401/402 are
 * credential problems switching plans cannot fix.
 */
export function shouldFallbackPlan(status: number, plan: PlanTier): boolean {
  if (plan === "start-plan") {
    return status === 401 || status === 402 || status === 403 || status === 429 || status === 502 || status === 504;
  }
  return status === 429;
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

/** Record a fallback: cool the rejected plan down and pin the effective plan to the target until the watcher reassesses. */
export function notePlanFallback(rejected: PlanTier, target: PlanTier, onSwitch?: (message: string) => void): void {
  state.fallbackCooldownUntil = Date.now() + PLAN_FALLBACK_COOLDOWN_MS;
  setEffective(target, `upstream rejected ${rejected} — cooldown ${Math.round(PLAN_FALLBACK_COOLDOWN_MS / 60_000)}min`, onSwitch);
}

export interface PlanFallbackOutcome {
  handled: boolean;
  /** The plan the retry ran on; present when `handled` is true. */
  target?: PlanTier;
  /** The retry's response; present when `handled` is true. */
  resp?: Response;
}

/**
 * Per-request fallback seam (callback shape mirrors retryOnCaptchaChallenge):
 * when the serving plan rejected the request (error status OR a 200 JSON
 * error envelope, both detected by the caller), run the caller's next-plan
 * rebuild + dispatch ONCE with the target plan and record the cooldown first
 * so concurrent requests skip the broken plan. Runs regardless of
 * `planAutoSwitch`. `rebuildAndDispatch` errors propagate to the caller,
 * which maps them onto its own 502 path.
 */
export async function retryOnPlanExhausted(args: {
  rejected: boolean;
  plan: PlanTier;
  priority: PlanTier[];
  rebuildAndDispatch: (target: PlanTier) => Promise<Response>;
  onFallback?: (message: string) => void;
}): Promise<PlanFallbackOutcome> {
  if (!args.rejected) return { handled: false };
  const target = nextPlanInPriority(args.priority, args.plan);
  if (target === null) return { handled: false };
  notePlanFallback(args.plan, target, args.onFallback);
  const resp = await args.rebuildAndDispatch(target);
  return { handled: true, target, resp };
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

/** One watched window is exhausted when remaining hits 0 (used/total as the estimate when remaining is unreported). */
function codingLimitExhausted(row: QuotaCodingLimit): boolean {
  if (typeof row.remaining === "number") return row.remaining <= 0;
  if (typeof row.used === "number" && typeof row.total === "number") return row.used >= row.total;
  return false; // unreported numbers must not block the plan (fail-open)
}

/**
 * True when every watched coding window still has quota. A window with no
 * matching row (upstream sends fewer rows than we watch) counts as usable:
 * missing data must not block the plan.
 */
export function codingUsable(limits: QuotaCodingLimit[], watchTypes: string[]): boolean {
  return watchTypes.every((type) => {
    const row = limits.find((l) => l.type === type);
    return row === undefined || !codingLimitExhausted(row);
  });
}

/**
 * The plan to serve: the first priority entry whose watched signals still
 * have quota. When nothing is usable (every plane reports empty AND at least
 * one probe succeeded — a probe failure never reports unusable), the head of
 * the priority list serves and the requests get rejected upstream as usual.
 */
export function decidePlan(priority: PlanTier[], usable: Record<PlanTier, boolean>): PlanTier {
  for (const plan of priority) {
    if (usable[plan]) return plan;
  }
  return priority[0];
}

export interface PlanAutoWatcher {
  stop(): void;
  /** One quota probe → effective-plan update. Exposed for tests. */
  tick(): Promise<void>;
}

export interface PlanAutoWatcherDeps {
  fetchImpl?: typeof fetch;
  loadCredentialImpl?: Parameters<typeof fetchStartPlanBalance>[2];
  /** Override the coding-plane probe (for tests). Defaults to fetchCodingPlanUsage. */
  fetchCodingPlanUsageImpl?: typeof fetchCodingPlanUsage;
}

/**
 * Start the background quota watcher. The first probe runs immediately so the
 * optimistic priority[0] assumption is corrected within one request; later
 * probes run on `config.planPollIntervalSec`. Stop it on shutdown like the
 * claim scheduler (uncleared timers keep the process alive).
 */
export function startPlanAutoWatcher(config: ProxyConfig, deps: PlanAutoWatcherDeps = {}): PlanAutoWatcher {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fetchUsage = deps.fetchCodingPlanUsageImpl ?? fetchCodingPlanUsage;

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
      const errors: string[] = [];
      const [start, coding] = await Promise.all([
        fetchStartPlanBalance(config, deps.fetchImpl, deps.loadCredentialImpl).catch((err: Error) => {
          errors.push(err.message);
          return null;
        }),
        fetchUsage(config, deps.fetchImpl, deps.loadCredentialImpl).catch((err: Error) => {
          errors.push(err.message);
          return null;
        }),
      ]);

      if (start === null) {
        // No plan JWT (login pending, e.g. Android before first login) — no
        // data yet, retry on the next tick.
        errors.push("no plan JWT (login pending)");
      } else if (!start.ok) {
        errors.push(start.error ?? "balance probe failed");
      }
      // A probe we could not see must never block its plan (fail-open): only
      // a probe that SUCCEEDED and reports empty marks the plan unusable.
      const startUsable = start === null || !start.ok ? true : hasUsableBalance(start.balances);
      const codingUsableNow = coding === null || !coding.ok
        ? true
        : codingUsable(coding.limits, planWatchedLimitsOf(config, "coding-plan"));

      state.lastError = errors.length > 0 ? errors.join("; ") : null;
      applyDecision(config, { "start-plan": startUsable, "coding-plan": codingUsableNow });
    },
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void watcher.tick().finally(scheduleNext);
    }, planPollIntervalMsOf(config));
  };
  void watcher.tick().finally(scheduleNext);
  return watcher;
}

/** Apply one poll's verdict, holding the current plan through the fallback cooldown. */
function applyDecision(config: ProxyConfig, usable: Record<PlanTier, boolean>): void {
  // During the fallback cooldown the upstream may still report the rejected
  // plan as available while requests are actually refused — hold the current
  // effective plan until the cooldown lapses so the two plans do not flap.
  if (Date.now() < state.fallbackCooldownUntil) return;
  state.fallbackCooldownUntil = 0;
  setEffective(decidePlan(planPriorityOf(config), usable), decisionReason(usable));
}

function decisionReason(usable: Record<PlanTier, boolean>): string {
  const bits = (["start-plan", "coding-plan"] as PlanTier[]).map((p) => `${p} ${usable[p] ? "usable" : "empty"}`);
  return `poll: ${bits.join(", ")}`;
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
