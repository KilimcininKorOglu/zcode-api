/**
 * Tests for the planAutoReset service: status parsing, the trigger decision,
 * the idempotent single-flight spend, the 429 transient-code block, and the
 * poller's change-only logging.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  cachedResetRights,
  computeNextOpportunityCheckAt,
  fetchPlanResetStatus,
  getNextOpportunityCheckAt,
  isTransient429,
  maybeRequestPlanResetOpportunity,
  maybeUsePlanResetAndRetry,
  planAutoResetOf,
  requestPlanResetOpportunity,
  shouldUseReset,
  startPlanResetPoller,
  usePlanReset,
  OPPORTUNITY_ERROR_COOLDOWN_MS,
  OPPORTUNITY_MIN_INTERVAL_MS,
  OPPORTUNITY_SUCCESS_COOLDOWN_MS,
  OPPORTUNITY_THROTTLE_COOLDOWN_MS,
  __resetPlanResetStateForTests,
  __setNextOpportunityCheckAtForTests,
  __setPlanResetDepsForTests,
  __setResetRightsForTests,
} from "./reset.js";
import type { PlanAutoResetConfig, ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<PlanAutoResetConfig> = {}): ProxyConfig {
  return {
    plan: "coding-plan",
    planAutoReset: { enabled: true, useThresholdPercent: 90, useOn429: true, expireGraceSec: 600, statusPollIntervalSec: 300, ...overrides },
  } as ProxyConfig;
}

function cred(jwt?: string): Credential {
  return { apiKey: "key", secret: "sec", provider: "zai", ...(jwt ? { jwt } : {}) };
}

/** Wire a fetch mock and record every request. */
function mockFetch(
  handler: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  const impl = Object.assign(
    (async (input: string | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const url = typeof input === "string" ? input : input.url;
      const entry = { url, method: init?.method ?? "GET", body: init?.body, headers: init?.headers };
      calls.push(entry);
      return handler(url, { method: init?.method, body: init?.body, headers: init?.headers });
    }) as typeof fetch,
    { preconnect: () => {} },
  );
  return { fetch: impl, calls };
}

const STATUS_OK = JSON.stringify({
  code: 0,
  msg: "success",
  data: { available_five_hour_resets: [{ expire_at: 1_800_000_000_000 }], available_week_resets: [] },
});

beforeEach(() => {
  __resetPlanResetStateForTests();
});

describe("fetchPlanResetStatus", () => {
  it("returns null without a stored JWT (feature silently passive)", async () => {
    const { fetch } = mockFetch(() => new Response(STATUS_OK));
    const rights = await fetchPlanResetStatus(fetch, async () => cred(undefined));
    expect(rights).toBeNull();
  });

  it("parses the expire epochs from a success envelope", async () => {
    const { fetch, calls } = mockFetch(() => new Response(STATUS_OK));
    const rights = await fetchPlanResetStatus(fetch, async () => cred("jwt-1"));
    expect(rights).toEqual([1_800_000_000_000]);
    expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/status");
    expect(calls[0].headers?.authorization).toBe("Bearer jwt-1");
    expect(calls[0].headers?.["x-bigmodel-authorization"]).toBe("key");
    expect(calls[0].headers?.["bigmodel-target-type"]).toBe("PERSONAL");
  });

  it("injects client identity headers and coding plan token", async () => {
    const config = {
      ...makeConfig(),
      identity: {
        appVersion: "3.15.3",
        sourceTitle: "test-title",
        refererOrigin: "https://zcode.z.ai",
        deviceMid: "mid-uuid-123",
      },
    } as ProxyConfig;
    const { fetch, calls } = mockFetch(() => new Response(STATUS_OK));
    const rights = await fetchPlanResetStatus(fetch, async () => ({ ...cred("jwt-1"), oauthAccessToken: "oauth-tok" }), config);
    expect(rights).toEqual([1_800_000_000_000]);
    expect(calls[0].headers?.authorization).toBe("Bearer jwt-1");
    expect(calls[0].headers?.["x-bigmodel-authorization"]).toBe("oauth-tok");
    expect(calls[0].headers?.["X-Device-Mid"]).toBe("mid-uuid-123");
    expect(calls[0].headers?.["X-ZCode-App-Version"]).toBe("3.15.3");
  });

  it("returns null on a rejected envelope (network / auth errors)", async () => {
    const { fetch } = mockFetch(() => new Response('{"code":3001,"msg":"parameter error"}'));
    expect(await fetchPlanResetStatus(fetch, async () => cred("jwt-1"))).toBeNull();
  });
});

describe("shouldUseReset", () => {
  const cfg = makeConfig().planAutoReset as PlanAutoResetConfig;
  const now = 1_000_000_000_000;
  const rights = [now + 3600_000];

  it("is false with no held rights", () => {
    expect(shouldUseReset(99, [], cfg, now)).toBe(false);
  });

  it("fires at or above the threshold percent", () => {
    expect(shouldUseReset(90, rights, cfg, now)).toBe(true);
    expect(shouldUseReset(91, rights, cfg, now)).toBe(true);
    expect(shouldUseReset(89, rights, cfg, now)).toBe(false);
  });

  it("fires inside the expire grace window even at a low percent", () => {
    const soon = [now + 590_000];
    expect(shouldUseReset(10, soon, cfg, now)).toBe(true);
    expect(shouldUseReset(10, [now + 610_000], cfg, now)).toBe(false);
  });

  it("lets a missing percent fall to the expire trigger alone", () => {
    expect(shouldUseReset(null, [now + 100_000], cfg, now)).toBe(true);
    expect(shouldUseReset(null, rights, cfg, now)).toBe(false);
  });
});

describe("usePlanReset", () => {
  it("POSTs the idempotency-keyed FIVE_HOUR use and reports success", async () => {
    const { fetch, calls } = mockFetch(() => new Response('{"code":0,"msg":"success"}'));
    const ok = await usePlanReset(fetch, async () => cred("jwt-1"));
    expect(ok).toBe(true);
    expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/use");
    expect(calls[0].method).toBe("POST");
    const body = JSON.parse(calls[0].body ?? "{}") as { idempotency_key?: string; reset_type?: string };
    expect(body.reset_type).toBe("FIVE_HOUR");
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports failure and clears a stale rights cache when the use is rejected", async () => {
    __setResetRightsForTests([1_800_000_000_000]);
    const { fetch } = mockFetch(() => new Response('{"code":3301,"msg":"no opportunity"}'));
    expect(await usePlanReset(fetch, async () => cred("jwt-1"))).toBe(false);
    expect(cachedResetRights()).toEqual([]);
  });

  it("collapses concurrent spends into one request (single-flight)", async () => {
    let calls = 0;
    const { fetch } = mockFetch(() => {
      calls += 1;
      return new Response('{"code":0,"msg":"success"}');
    });
    const [a, b] = await Promise.all([usePlanReset(fetch, async () => cred("jwt-1")), usePlanReset(fetch, async () => cred("jwt-1"))]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("isTransient429", () => {
  it("recognizes the transient rate-limit codes in both envelope shapes", () => {
    expect(isTransient429('{"code":1305,"msg":"platform load"}')).toBe(true);
    expect(isTransient429('{"error":{"code":1302}}')).toBe(true);
  });

  it("treats terminal quota codes, other codes and non-JSON as spendable", () => {
    expect(isTransient429('{"code":1308,"msg":"usage cap"}')).toBe(false);
    expect(isTransient429('{"error":{"type":"rate_limit_error"}}')).toBe(false);
    expect(isTransient429("rate limited")).toBe(false);
    expect(isTransient429(null)).toBe(false);
  });
});

describe("maybeUsePlanResetAndRetry", () => {
  it("does nothing without a held right (fallback seam stays untouched)", async () => {
    let rebuilt = 0;
    const outcome = await maybeUsePlanResetAndRetry({
      plan: "coding-plan",
      config: makeConfig(),
      rejectionBody: null,
      rebuildAndDispatch: async () => {
        rebuilt += 1;
        return new Response("ok");
      },
    });
    expect(outcome.handled).toBe(false);
    expect(rebuilt).toBe(0);
  });

  it("never fires for a plan other than coding-plan", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    const outcome = await maybeUsePlanResetAndRetry({
      plan: "start-plan",
      config: makeConfig(),
      rejectionBody: null,
      rebuildAndDispatch: async () => new Response("ok"),
    });
    expect(outcome.handled).toBe(false);
  });

  it("blocks the spend on a transient rate-limit body", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    const outcome = await maybeUsePlanResetAndRetry({
      plan: "coding-plan",
      config: makeConfig(),
      rejectionBody: '{"code":1305,"msg":"platform load"}',
      rebuildAndDispatch: async () => new Response("ok"),
    });
    expect(outcome.handled).toBe(false);
  });

  it("spends the right and retries the SAME request on a terminal 429", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    const { fetch } = mockFetch(() => new Response('{"code":0,"msg":"success"}'));
    // The seam calls usePlanReset without injection points; the test deps
    // route that request here instead of the network.
    __setPlanResetDepsForTests({ fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
    const rebuiltOn: string[] = [];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const outcome = await maybeUsePlanResetAndRetry({
        plan: "coding-plan",
        config: makeConfig(),
        rejectionBody: '{"error":{"type":"rate_limit_error"}}',
        rebuildAndDispatch: async (target) => {
          rebuiltOn.push(target);
          return new Response("reopened reply");
        },
      });
      expect(outcome.handled).toBe(true);
      await outcome.resp?.text();
    } finally {
      console.log = origLog;
    }
    expect(rebuiltOn).toEqual(["coding-plan"]);
    expect(lines.some((l) => l.includes("used FIVE_HOUR reset right on a coding-plan 429"))).toBe(true);
  });

  it("is disabled by the config flag", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    const outcome = await maybeUsePlanResetAndRetry({
      plan: "coding-plan",
      config: makeConfig({ enabled: false }),
      rejectionBody: null,
      rebuildAndDispatch: async () => new Response("ok"),
    });
    expect(outcome.handled).toBe(false);
  });

  it("notes when the server spares the earliest right and burns a longer-lived one", async () => {
    const earliest = Date.now() + 3600_000;
    const latest = Date.now() + 61 * 86_400_000;
    __setResetRightsForTests([latest, earliest]);
    // /use succeeds, then the post-spend status still lists the earliest
    // right — the server consumed the longer-lived one.
    const { fetch } = mockFetch((url) =>
      new Response(url.includes("/reset/use") ? '{"code":0,"msg":"success"}' : JSON.stringify({ code: 0, data: { available_five_hour_resets: [{ expire_at: earliest }] } })),
    );
    __setPlanResetDepsForTests({ fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const outcome = await maybeUsePlanResetAndRetry({
        plan: "coding-plan",
        config: makeConfig(),
        rejectionBody: '{"error":{"type":"rate_limit_error"}}',
        rebuildAndDispatch: async () => new Response("ok"),
      });
      expect(outcome.handled).toBe(true);
    } finally {
      console.log = origLog;
    }
    expect(lines.some((l) => l.includes("NOTE server spent the longer-lived right"))).toBe(true);
    expect(lines.some((l) => l.includes("expires in 61d"))).toBe(true);
    // The cache reflects the post-spend truth.
    expect(cachedResetRights()).toEqual([earliest]);
  });

  it("stays silent when the earliest right is the one spent", async () => {
    const earliest = Date.now() + 3600_000;
    const latest = Date.now() + 61 * 86_400_000;
    __setResetRightsForTests([latest, earliest]);
    // After the spend only the longer-lived right remains.
    const { fetch } = mockFetch((url) =>
      new Response(url.includes("/reset/use") ? '{"code":0,"msg":"success"}' : JSON.stringify({ code: 0, data: { available_five_hour_resets: [{ expire_at: latest }] } })),
    );
    __setPlanResetDepsForTests({ fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const outcome = await maybeUsePlanResetAndRetry({
        plan: "coding-plan",
        config: makeConfig(),
        rejectionBody: '{"error":{"type":"rate_limit_error"}}',
        rebuildAndDispatch: async () => new Response("ok"),
      });
      expect(outcome.handled).toBe(true);
    } finally {
      console.log = origLog;
    }
    expect(lines.some((l) => l.includes("NOTE server spent the longer-lived right"))).toBe(false);
    expect(cachedResetRights()).toEqual([latest]);
  });

  it("skips the 429 trigger when useOn429 is off", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    let rebuilt = 0;
    const outcome = await maybeUsePlanResetAndRetry({
      plan: "coding-plan",
      config: makeConfig({ useOn429: false }),
      rejectionBody: '{"error":{"type":"rate_limit_error"}}',
      rebuildAndDispatch: async () => {
        rebuilt += 1;
        return new Response("ok");
      },
    });
    expect(outcome.handled).toBe(false);
    expect(rebuilt).toBe(0);
  });
});

describe("startPlanResetPoller", () => {
  it("logs a granted right once and stays silent while unchanged", async () => {
    const { fetch } = mockFetch(() => new Response(STATUS_OK));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const poller = startPlanResetPoller(makeConfig(), { fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
      await poller.tick();
      await poller.tick();
      poller.stop();
    } finally {
      console.log = origLog;
    }
    const granted = lines.filter((l) => l.includes("1 FIVE_HOUR right(s) available"));
    expect(granted).toHaveLength(1);
  });

  it("renders long expiry in days, not raw hours", async () => {
    const far = JSON.stringify({
      code: 0,
      data: { available_five_hour_resets: [{ expire_at: Date.now() + 61 * 86_400_000 + 40 * 60_000 }] },
    });
    const { fetch } = mockFetch(() => new Response(far));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const poller = startPlanResetPoller(makeConfig(), { fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
      await poller.tick();
      poller.stop();
    } finally {
      console.log = origLog;
    }
    expect(lines.some((l) => l.includes("expires in 61d"))).toBe(true);
    expect(lines.some((l) => l.includes("1464h"))).toBe(false);
  });

  it("clears the cache to empty when the server reports no rights", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    const { fetch } = mockFetch(() => new Response('{"code":0,"data":{"available_five_hour_resets":[]}}'));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const poller = startPlanResetPoller(makeConfig(), { fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
      await poller.tick();
      poller.stop();
    } finally {
      console.log = origLog;
    }
    expect(cachedResetRights()).toEqual([]);
    expect(lines.some((l) => l.includes("no FIVE_HOUR rights left"))).toBe(true);
  });

  it("skips opportunity request when reset rights are already cached", async () => {
    __setResetRightsForTests([Date.now() + 3600_000]);
    const { fetch, calls } = mockFetch(() => new Response(STATUS_OK));
    const poller = startPlanResetPoller(makeConfig(), { fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
    await poller.tick();
    poller.stop();
    expect(calls.some((c) => c.url.includes("/opportunity"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/status"))).toBe(true);
  });

  it("exposes the config defaults through planAutoResetOf", () => {
    const bare = { plan: "coding-plan" } as ProxyConfig;
    expect(planAutoResetOf(bare).enabled).toBe(true);
    expect(planAutoResetOf(bare).useThresholdPercent).toBe(90);
    expect(planAutoResetOf(bare).statusPollIntervalSec).toBe(300);
  });
});

describe("requestPlanResetOpportunity", () => {
  it("returns null without a stored JWT", async () => {
    const { fetch } = mockFetch(() => new Response('{"code":0,"data":{"granted":true}}'));
    const res = await requestPlanResetOpportunity(fetch, async () => cred(undefined));
    expect(res).toBeNull();
  });

  it("parses granted: true from code 0 envelope", async () => {
    const { fetch, calls } = mockFetch(() => new Response('{"code":0,"msg":"success","data":{"granted":true}}'));
    const res = await requestPlanResetOpportunity(fetch, async () => cred("jwt-1"));
    expect(res).toEqual({ granted: true, nextTryAt: null });
    expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/opportunity");
    expect(calls[0].method).toBe("POST");
    const body = JSON.parse(calls[0].body ?? "{}") as { idempotency_key?: string };
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].headers?.authorization).toBe("Bearer jwt-1");
  });

  it("parses code 3301 not-allowed with next_try_at timestamp", async () => {
    const { fetch } = mockFetch(
      () => new Response('{"code":3301,"msg":"coding plan reset grant not allowed","data":{"granted":false,"next_try_at":1792168771874}}'),
    );
    const res = await requestPlanResetOpportunity(fetch, async () => cred("jwt-1"));
    expect(res).toEqual({ granted: false, nextTryAt: 1792168771874 });
  });

  it("handles HTTP 429 throttle with backoff nextTryAt", async () => {
    const now = Date.now();
    const { fetch } = mockFetch(() => new Response("Too Many Requests", { status: 429 }));
    const res = await requestPlanResetOpportunity(fetch, async () => cred("jwt-1"));
    expect(res?.granted).toBe(false);
    expect(res?.nextTryAt).toBeGreaterThanOrEqual(now + OPPORTUNITY_THROTTLE_COOLDOWN_MS - 100);
  });

  it("retains idempotency key on network failure and reuses it", async () => {
    let failOnce = true;
    const { fetch, calls } = mockFetch(() => {
      if (failOnce) {
        failOnce = false;
        throw new Error("network down");
      }
      return new Response('{"code":0,"data":{"granted":true}}');
    });
    const first = await requestPlanResetOpportunity(fetch, async () => cred("jwt-1"));
    expect(first).toBeNull();
    const second = await requestPlanResetOpportunity(fetch, async () => cred("jwt-1"));
    expect(second?.granted).toBe(true);
    expect(calls).toHaveLength(2);
    const key1 = JSON.parse(calls[0].body ?? "{}").idempotency_key;
    const key2 = JSON.parse(calls[1].body ?? "{}").idempotency_key;
    expect(key1).toBe(key2);
  });
});

describe("computeNextOpportunityCheckAt", () => {
  const now = 1_000_000_000_000;

  it("adds error cooldown when result is null", () => {
    expect(computeNextOpportunityCheckAt(null, now)).toBe(now + OPPORTUNITY_ERROR_COOLDOWN_MS);
  });

  it("adds success cooldown when granted", () => {
    expect(computeNextOpportunityCheckAt({ granted: true, nextTryAt: null }, now)).toBe(now + OPPORTUNITY_SUCCESS_COOLDOWN_MS);
  });

  it("respects next_try_at when beyond min interval", () => {
    const future = now + 600_000;
    expect(computeNextOpportunityCheckAt({ granted: false, nextTryAt: future }, now)).toBe(future);
  });

  it("enforces minimum interval if next_try_at is sooner", () => {
    const sooner = now + 60_000;
    expect(computeNextOpportunityCheckAt({ granted: false, nextTryAt: sooner }, now)).toBe(now + OPPORTUNITY_MIN_INTERVAL_MS);
  });
});

describe("maybeRequestPlanResetOpportunity", () => {
  it("skips network call when current time is before nextOpportunityCheckAt", async () => {
    const now = 1_000_000_000_000;
    __setNextOpportunityCheckAtForTests(now + 60_000);
    let called = 0;
    const { fetch } = mockFetch(() => {
      called += 1;
      return new Response('{"code":0,"data":{"granted":true}}');
    });
    const ok = await maybeRequestPlanResetOpportunity(fetch, async () => cred("jwt-1"), now);
    expect(ok).toBe(false);
    expect(called).toBe(0);
  });

  it("executes when due and updates nextOpportunityCheckAt", async () => {
    const now = 1_000_000_000_000;
    __setNextOpportunityCheckAtForTests(now - 1000);
    const { fetch } = mockFetch(
      () => new Response('{"code":3301,"data":{"granted":false,"next_try_at":' + (now + 700_000) + "}}"),
    );
    const ok = await maybeRequestPlanResetOpportunity(fetch, async () => cred("jwt-1"), now);
    expect(ok).toBe(false);
    expect(getNextOpportunityCheckAt()).toBe(now + 700_000);
  });

  it("collapses concurrent probes into single flight", async () => {
    let calls = 0;
    const { fetch } = mockFetch(() => {
      calls += 1;
      return new Response('{"code":0,"data":{"granted":true}}');
    });
    const [a, b] = await Promise.all([
      maybeRequestPlanResetOpportunity(fetch, async () => cred("jwt-1")),
      maybeRequestPlanResetOpportunity(fetch, async () => cred("jwt-1")),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("poller opportunity integration", () => {
  it("claims opportunity and updates rights on poller tick", async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes("/opportunity")) {
        return new Response('{"code":0,"msg":"success","data":{"granted":true}}');
      }
      return new Response(STATUS_OK);
    });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const poller = startPlanResetPoller(makeConfig(), { fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-1") });
      await poller.tick();
      poller.stop();
    } finally {
      console.log = origLog;
    }
    expect(calls.some((c) => c.url.includes("/opportunity"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/status"))).toBe(true);
    expect(lines.some((l) => l.includes("granted a new FIVE_HOUR reset opportunity"))).toBe(true);
    expect(lines.some((l) => l.includes("1 FIVE_HOUR right(s) available"))).toBe(true);
  });
});

