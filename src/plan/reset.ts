/**
 * Automatic use of the upstream coding-plan 5h-window reset rights — the
 * server-granted rights behind ZCode's "🎁 N reset available / Expires in Xm"
 * badge (contract: zai-org/ZCode `docs/coding-plan-quota-reset-ui.md`).
 *
 * The rights live on a separate plane from the usage windows the watcher
 * polls: `GET https://zcode.z.ai/api/v1/coding-plan/reset/status` reports
 * `available_five_hour_resets[{expire_at}]` (plus the week variant, unused
 * here). The poller actively claims available opportunities via
 * `POST https://zcode.z.ai/api/v1/coding-plan/reset/opportunity` on the official
 * client's cadence (respecting server next_try_at cooldowns and 429 throttle
 * backoff), and spends a held right (`POST .../reset/use`, reset_type:
 * "FIVE_HOUR", idempotency-keyed) when one of the configured triggers holds:
 *
 *   - the 5h window's used share reaches `useThresholdPercent` (default 90),
 *   - a held right's remaining lifetime drops below `expireGraceSec`
 *     (default 600s) so it never simply expires,
 *   - a coding-plan request got a 429 and a right is on hand: spend it and
 *     retry the SAME request on the reopened window instead of falling to the
 *     other plan.
 *
 * Status is polled every `statusPollIntervalSec` (default 300s — the official
 * client's cadence). Auth: `Authorization: Bearer <zcode JWT>`,
 * `X-Bigmodel-Authorization: <MaaS coding-plan token>`,
 * `Bigmodel-Target-Type: PERSONAL`. Client identity headers (X-Device-Mid,
 * User-Agent, X-ZCode-App-Version, etc.) are injected to match the official
 * desktop client. Without a stored JWT the whole feature stays silently passive.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_PLAN_AUTO_RESET, type PlanAutoResetConfig, type ProxyConfig } from "../config/types.js";
import { loadCredential } from "../auth/store.js";
import type { Credential } from "../auth/types.js";
import { buildIdentityHeaders } from "../proxy/identity.js";
import type { PlanTier } from "./auto.js";

/** The reset plane lives on the ZCode gateway, not on the data-plane origin. */
const RESET_ORIGIN = "https://zcode.z.ai";

/** Cooldown applied after an opportunity is successfully granted (10 minutes, matching ZCode's oDt). */
export const OPPORTUNITY_SUCCESS_COOLDOWN_MS = 10 * 60_000;

/** Minimum spacing between opportunity requests when the server declines (5 minutes, matching ZCode's aDt). */
export const OPPORTUNITY_MIN_INTERVAL_MS = 5 * 60_000;

/** Backoff applied when the server returns HTTP 429 throttle (10 minutes, matching ZCode's cDt). */
export const OPPORTUNITY_THROTTLE_COOLDOWN_MS = 10 * 60_000;

/** Backoff applied on network/transport errors (5 minutes, matching ZCode's sDt). */
export const OPPORTUNITY_ERROR_COOLDOWN_MS = 5 * 60_000;

/** Config accessor: fail open to the shipped defaults (fixtures omit the block). */
export function planAutoResetOf(config: ProxyConfig): PlanAutoResetConfig {
  return config.planAutoReset ?? DEFAULT_PLAN_AUTO_RESET;
}

let activeConfig: ProxyConfig | null = null;

/** Reset-plane headers for a stored credential; null without a zcode JWT. */
function resetHeaders(cred: Credential | null, config?: ProxyConfig): Record<string, string> | null {
  if (!cred?.jwt) return null;
  const cfg = config ?? activeConfig;
  const codingPlanAuth = cred.oauthAccessToken ?? cred.apiKey;
  const identity = cfg?.identity ? buildIdentityHeaders(cfg.identity) : {};
  return {
    ...identity,
    authorization: `Bearer ${cred.jwt}`,
    "x-bigmodel-authorization": codingPlanAuth,
    "bigmodel-target-type": "PERSONAL",
    accept: "application/json",
  };
}

type Envelope = { code?: number; msg?: string; data?: unknown; success?: unknown; status?: number };

/** JSON envelope for a reset-plane call; a non-JSON body keeps the HTTP status. */
async function requestEnvelope(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Envelope | null> {
  try {
    const resp = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await resp.text();
    try {
      const parsed = JSON.parse(text) as Envelope;
      return { status: resp.status, ...parsed };
    } catch {
      return { status: resp.status, code: resp.status, msg: text.slice(0, 120) };
    }
  } catch (e) {
    return { code: -1, msg: String(e).slice(0, 120) };
  }
}

/**
 * Read the granted rights. Returns the `expire_at` epochs (ms) of the live
 * FIVE_HOUR rights, `[]` when the server reports none, and `null` when the
 * plane is unreadable (no JWT, network error, non-success envelope) — the
 * caller keeps its previous cache in that case.
 */
export async function fetchPlanResetStatus(
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
  config?: ProxyConfig,
): Promise<number[] | null> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  const cred = await loadCredentialImpl().catch(() => null);
  const headers = resetHeaders(cred ?? null, config);
  if (!headers) return null;
  const env = await requestEnvelope(`${RESET_ORIGIN}/api/v1/coding-plan/reset/status`, "GET", undefined, headers, fetchImpl);
  if (!env || env.code !== 0) return null;
  const data = (env.data ?? {}) as { available_five_hour_resets?: unknown };
  const rows = Array.isArray(data.available_five_hour_resets) ? data.available_five_hour_resets : [];
  return rows
    .map((r) => (r && typeof r === "object" ? (r as { expire_at?: unknown }).expire_at : undefined))
    .filter((v): v is number => typeof v === "number");
}

export interface ResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}

let nextOpportunityCheckAt = 0;
let pendingOpportunityKey: string | null = null;
let opportunityInFlight: Promise<ResetOpportunityResult | null> | null = null;

export function getNextOpportunityCheckAt(): number {
  return nextOpportunityCheckAt;
}

/**
 * Request an opportunity to receive a reset right from the server (POST .../reset/opportunity).
 * Mirrors the official ZCode client's `requestCodingPlanResetOpportunity` RPC:
 * - code 0, data.granted: true -> granted
 * - code 3301, data.next_try_at -> not granted yet, try again after next_try_at
 * - HTTP 429 / code 429 / 1303 -> throttled, back off
 * - null on unreadable envelope or missing JWT
 */
export async function requestPlanResetOpportunity(
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
  idempotencyKey?: string,
  config?: ProxyConfig,
): Promise<ResetOpportunityResult | null> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  const cred = await loadCredentialImpl().catch(() => null);
  const headers = resetHeaders(cred ?? null, config);
  if (!headers) return null;

  const key = idempotencyKey ?? pendingOpportunityKey ?? randomUUID();
  const env = await requestEnvelope(
    `${RESET_ORIGIN}/api/v1/coding-plan/reset/opportunity`,
    "POST",
    JSON.stringify({ idempotency_key: key }),
    { ...headers, "content-type": "application/json" },
    fetchImpl,
  );

  if (!env || env.code === -1) {
    pendingOpportunityKey = key;
    return null;
  }

  pendingOpportunityKey = null;

  if (env.status === 429 || env.code === 429 || env.code === 1303) {
    return { granted: false, nextTryAt: Date.now() + OPPORTUNITY_THROTTLE_COOLDOWN_MS };
  }

  if (env.code === 0) {
    const data = (env.data ?? {}) as { granted?: unknown };
    return { granted: data.granted === true, nextTryAt: null };
  }

  if (env.code === 3301) {
    const data = (env.data ?? {}) as { granted?: unknown; next_try_at?: unknown };
    const nextTryAt =
      typeof data.next_try_at === "number" && Number.isFinite(data.next_try_at) && data.next_try_at > 0
        ? data.next_try_at
        : null;
    return { granted: false, nextTryAt };
  }

  return null;
}

/** Compute the epoch (ms) when the next opportunity check should happen. */
export function computeNextOpportunityCheckAt(
  result: ResetOpportunityResult | null,
  nowMs: number,
): number {
  if (!result) {
    return nowMs + OPPORTUNITY_ERROR_COOLDOWN_MS;
  }
  if (result.granted) {
    return nowMs + OPPORTUNITY_SUCCESS_COOLDOWN_MS;
  }
  if (result.nextTryAt !== null) {
    return Math.max(result.nextTryAt, nowMs + OPPORTUNITY_MIN_INTERVAL_MS);
  }
  return nowMs + OPPORTUNITY_SUCCESS_COOLDOWN_MS;
}

/**
 * Perform an opportunity probe if the current time is past nextOpportunityCheckAt.
 * Single-flight: concurrent callers share the in-flight probe.
 * Returns true if a new reset right was granted.
 */
export async function maybeRequestPlanResetOpportunity(
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
  nowMs: number = Date.now(),
  config?: ProxyConfig,
): Promise<boolean> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  if (nowMs < nextOpportunityCheckAt) return false;
  if (opportunityInFlight) {
    const res = await opportunityInFlight;
    return res?.granted ?? false;
  }

  opportunityInFlight = requestPlanResetOpportunity(fetchImpl, loadCredentialImpl, undefined, config).finally(() => {
    opportunityInFlight = null;
  });

  const res = await opportunityInFlight;
  nextOpportunityCheckAt = computeNextOpportunityCheckAt(res, nowMs);
  if (res?.granted) {
    console.log("plan reset: upstream granted a new FIVE_HOUR reset opportunity");
    return true;
  }
  const nextIn = res?.nextTryAt ? ` (next check in ${fmtDuration(res.nextTryAt - nowMs)})` : "";
  console.log(`plan reset: checked opportunity — no reset opportunity available${nextIn}`);
  return false;
}

/**
 * Spend one FIVE_HOUR right. Single-flight: concurrent callers share the
 * in-flight request instead of double-spending. A failure clears the rights
 * cache (the optimistic data was wrong; the next poll refills it).
 */
export async function usePlanReset(
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
  config?: ProxyConfig,
): Promise<boolean> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  if (useInFlight) return useInFlight;
  useInFlight = spendReset(fetchImpl, loadCredentialImpl, config).finally(() => {
    useInFlight = null;
  });
  return useInFlight;
}

let useInFlight: Promise<boolean> | null = null;

async function spendReset(
  fetchImpl: typeof fetch,
  loadCredentialImpl: typeof loadCredential,
  config?: ProxyConfig,
): Promise<boolean> {
  const cred = await loadCredentialImpl().catch(() => null);
  const headers = resetHeaders(cred ?? null, config);
  if (!headers) return false;
  const env = await requestEnvelope(
    `${RESET_ORIGIN}/api/v1/coding-plan/reset/use`,
    "POST",
    JSON.stringify({ idempotency_key: randomUUID(), reset_type: "FIVE_HOUR" }),
    { ...headers, "content-type": "application/json" },
    fetchImpl,
  );
  const ok = env !== null && env.code === 0;
  if (!ok) cachedFiveHourResets = [];
  return ok;
}

/** The last successful poll's live rights (epoch ms, unsorted). */
let cachedFiveHourResets: number[] = [];

/** The rights cache, for the trigger checks and tests. */
export function cachedResetRights(): number[] {
  return cachedFiveHourResets;
}

/**
 * The tick-side trigger decision: a held right is spent when the 5h window is
 * at/over the configured threshold OR the right is about to expire. A missing
 * percent (window row absent) only lets the expire trigger fire.
 */
export function shouldUseReset(percentUsed: number | null, rights: number[], cfg: PlanAutoResetConfig, nowMs: number): boolean {
  if (rights.length === 0) return false;
  if (percentUsed !== null && percentUsed >= cfg.useThresholdPercent) return true;
  const soonest = Math.min(...rights);
  return soonest - nowMs < cfg.expireGraceSec * 1000;
}

/**
 * Tick-side use: called by the plan watcher with the fresh TOKENS_LIMIT
 * percent. Spends a right when a trigger holds and logs the spend once.
 */
export async function maybeUseResetOnTick(config: ProxyConfig, percentUsed: number | null): Promise<void> {
  activeConfig = config;
  const cfg = planAutoResetOf(config);
  if (!cfg.enabled || cachedFiveHourResets.length === 0) return;
  if (!shouldUseReset(percentUsed, cachedFiveHourResets, cfg, Date.now())) return;
  const ok = await usePlanReset(undefined, undefined, config);
  if (ok) {
    console.log(`plan reset: used FIVE_HOUR reset right (5h window ${percentUsed === null ? "unknown" : `%${percentUsed}`} used) — window re-opened`);
  }
}

/**
 * HTTP 429 can carry a business code in a JSON body, and the official ZCode
 * client (`docs/bigmodel-business-error-retry.md`) splits those codes in two:
 * transient rate-limit signals (1302 concurrency, 1303 call frequency, 1305
 * platform load, 1312 model load) vs terminal quota signals (1304 daily cap,
 * 1308 usage cap, 1310 weekly/monthly quota, 1313 fair usage — the doc notes
 * these arrive AS 429s). A reset right spent on a TRANSIENT 429 is wasted:
 * the window is not exhausted. Only a terminal or unreadable rejection
 * (the shape every live window exhaustion took) justifies the spend.
 */
const TRANSIENT_429_CODES = new Set([1302, 1303, 1305, 1312]);

/** True when a 429 body carries one of the known transient rate-limit codes. */
export function isTransient429(bodyText: string | null): boolean {
  if (!bodyText) return false;
  try {
    const body = JSON.parse(bodyText) as { code?: unknown; error?: { code?: unknown } };
    const code = typeof body.code === "number"
      ? body.code
      : typeof body.error?.code === "number" ? body.error.code : undefined;
    return code !== undefined && TRANSIENT_429_CODES.has(code);
  } catch {
    return false;
  }
}

/**
 * Request-side use: when a coding-plan request was just rejected with 429 and
 * a right is on hand, spend it and rebuild+dispatch the SAME request once on
 * the reopened window (the plan fallback never runs, no cooldown is written).
 * A transient rate-limit body (1302/1303/1305/1312) blocks the spend — that
 * 429 is load, not exhaustion. `handled:false` hands control back to the
 * existing fallback seam untouched.
 */
export async function maybeUsePlanResetAndRetry(args: {
  plan: PlanTier;
  config: ProxyConfig;
  /** The rejected response's body text, when it was readable (bounded by the caller). */
  rejectionBody?: string | null;
  rebuildAndDispatch: (plan: PlanTier) => Promise<Response>;
}): Promise<{ handled: boolean; resp?: Response }> {
  activeConfig = args.config;
  const cfg = planAutoResetOf(args.config);
  if (!cfg.enabled || args.plan !== "coding-plan" || cachedFiveHourResets.length === 0) return { handled: false };
  if (!cfg.useOn429) return { handled: false };
  if (isTransient429(args.rejectionBody ?? null)) return { handled: false };
  const ok = await usePlanReset(undefined, undefined, args.config);
  if (!ok) return { handled: false };
  console.log("plan reset: used FIVE_HOUR reset right on a coding-plan 429 — window re-opened, retrying the request");
  const resp = await args.rebuildAndDispatch(args.plan);
  return { handled: true, resp };
}

/** `8m` / `2h 13m` — the small duration formatter for reset log lines. */
function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export interface PlanResetPoller {
  stop(): void;
  /** One status fetch → cache + one change log line. Exposed for tests. */
  tick(): Promise<void>;
}

export interface PlanResetPollerDeps {
  fetchImpl?: typeof fetch;
  loadCredentialImpl?: typeof loadCredential;
}

/**
 * Poll the reset plane and keep the rights cache warm. One log line per
 * CHANGE (rights granted, spent elsewhere, or all gone) — silence while the
 * picture is unchanged. The immediate first tick corrects the empty cache
 * within one status call.
 */
export function startPlanResetPoller(config: ProxyConfig, deps: PlanResetPollerDeps = {}): PlanResetPoller {
  activeConfig = config;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstRun = true;
  const intervalMs = planAutoResetOf(config).statusPollIntervalSec * 1000;

  const poller: PlanResetPoller = {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async tick(): Promise<void> {
      if (stopped) return;
      if (cachedFiveHourResets.length === 0) {
        await maybeRequestPlanResetOpportunity(deps.fetchImpl, deps.loadCredentialImpl, Date.now(), config);
      }
      const rights = await fetchPlanResetStatus(deps.fetchImpl, deps.loadCredentialImpl, config);
      if (rights === null) return;
      const prev = cachedFiveHourResets;
      cachedFiveHourResets = rights;
      const changed = rights.length !== prev.length || rights[0] !== prev[0];
      if (rights.length > 0) {
        if (firstRun || changed) {
          console.log(`plan reset: ${rights.length} FIVE_HOUR right(s) available (soonest expires in ${fmtDuration(Math.min(...rights) - Date.now())})`);
        }
      } else {
        if (prev.length > 0) {
          console.log("plan reset: no FIVE_HOUR rights left");
        } else if (firstRun) {
          console.log("plan reset: checked status — 0 FIVE_HOUR rights available");
        }
      }
      firstRun = false;
    },
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void poller.tick().finally(scheduleNext);
    }, intervalMs);
  };
  void poller.tick().finally(scheduleNext);
  return poller;
}

/** Restore pristine module state in tests. */
export function __resetPlanResetStateForTests(): void {
  cachedFiveHourResets = [];
  useInFlight = null;
  opportunityInFlight = null;
  nextOpportunityCheckAt = 0;
  pendingOpportunityKey = null;
  testFetchImpl = null;
  testLoadCredentialImpl = null;
  activeConfig = null;
}

/** Seed nextOpportunityCheckAt directly (tests only). */
export function __setNextOpportunityCheckAtForTests(ms: number): void {
  nextOpportunityCheckAt = ms;
}

/** Seed the rights cache directly (tests only). */
export function __setResetRightsForTests(rights: number[]): void {
  cachedFiveHourResets = [...rights];
}

let testFetchImpl: typeof fetch | null = null;
let testLoadCredentialImpl: typeof loadCredential | null = null;

/**
 * Swap the transport for the seams tests drive indirectly (the watcher tick
 * and the request handlers call this module without injection points).
 */
export function __setPlanResetDepsForTests(deps: { fetchImpl: typeof fetch; loadCredentialImpl: () => Promise<Credential | null> }): void {
  testFetchImpl = deps.fetchImpl;
  testLoadCredentialImpl = deps.loadCredentialImpl;
}
