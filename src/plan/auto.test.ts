/**
 * Tests for the hybrid plan auto-switch: the balance rule, per-request plan
 * resolution, the fallback seam, and the background watcher's tick.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  activePlan,
  hasUsableBalance,
  notePlanFallback,
  shouldFallbackPlan,
  sniffStartPlanRejection,
  startPlanAutoWatcher,
  PLAN_FALLBACK_COOLDOWN_MS,
  __resetPlanAutoStateForTests,
  __setFallbackCooldownForTests,
} from "./auto.js";
import type { QuotaBalanceEntry } from "../server/routes-quota.js";
import type { ProxyConfig } from "../config/types.js";

/** Minimal config fixture — plan/auto only reads plan, planAutoSwitch and claim.origin. */
function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    plan: "coding-plan",
    planAutoSwitch: true,
    claim: { origin: "https://zcode.z.ai" },
    identity: { appVersion: "test" },
    ...overrides,
  } as unknown as ProxyConfig;
}

function balance(overrides: Partial<QuotaBalanceEntry> = {}): QuotaBalanceEntry {
  return { showName: "Weekend", remainingUnits: 5, totalUnits: 10, usedUnits: 5, ...overrides };
}

beforeEach(() => {
  __resetPlanAutoStateForTests();
});

describe("hasUsableBalance", () => {
  const now = 1_800_000_000_000;

  it("accepts a bucket with remaining units and no expiry", () => {
    expect(hasUsableBalance([balance({ expiresAt: undefined })], now)).toBe(true);
  });

  it("accepts a future expiry in seconds or milliseconds", () => {
    expect(hasUsableBalance([balance({ expiresAt: now / 1000 + 60 })], now)).toBe(true);
    expect(hasUsableBalance([balance({ expiresAt: now + 60_000 })], now)).toBe(true);
  });

  it("rejects empty, zero and expired buckets", () => {
    expect(hasUsableBalance([], now)).toBe(false);
    expect(hasUsableBalance([balance({ remainingUnits: 0 })], now)).toBe(false);
    expect(hasUsableBalance([balance({ expiresAt: now / 1000 - 1 })], now)).toBe(false);
    expect(hasUsableBalance([balance({ expiresAt: now - 1 })], now)).toBe(false);
  });
});

describe("activePlan", () => {
  it("returns config.plan untouched when planAutoSwitch is off", () => {
    const cfg = makeConfig({ plan: "start-plan", planAutoSwitch: false });
    expect(activePlan(cfg)).toBe("start-plan");
  });

  it("assumes start-plan before the first balance probe", () => {
    expect(activePlan(makeConfig())).toBe("start-plan");
  });

  it("follows the watcher's effective plan", () => {
    notePlanFallback();
    expect(activePlan(makeConfig())).toBe("coding-plan");
  });
});

describe("shouldFallbackPlan", () => {
  it("never falls back when planAutoSwitch is off", () => {
    const cfg = makeConfig({ planAutoSwitch: false });
    expect(shouldFallbackPlan(402, "start-plan", cfg)).toBe(false);
  });

  it("falls back for start-plan auth/quota rejections and exhaustion 429s", () => {
    const cfg = makeConfig();
    expect(shouldFallbackPlan(401, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(402, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(403, "start-plan", cfg)).toBe(true);
    // A start-plan 429 is plan exhaustion, not load: the auto-claim loop kept
    // refreshing balances while every request was rejected (live 2026-10-05).
    expect(shouldFallbackPlan(429, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(500, "start-plan", cfg)).toBe(false);
    expect(shouldFallbackPlan(402, "coding-plan", cfg)).toBe(false);
  });

  it("falls back when the start-plan gateway itself is failing (502/504)", () => {
    const cfg = makeConfig();
    expect(shouldFallbackPlan(502, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(504, "start-plan", cfg)).toBe(true);
    // Other 5xx and rate limits are load signals, not plan failures; and the
    // coding plan has no further fallback target.
    expect(shouldFallbackPlan(503, "start-plan", cfg)).toBe(false);
    expect(shouldFallbackPlan(500, "coding-plan", cfg)).toBe(false);
    expect(shouldFallbackPlan(502, "coding-plan", cfg)).toBe(false);
    expect(shouldFallbackPlan(504, "coding-plan", cfg)).toBe(false);
  });
});

describe("notePlanFallback", () => {
  it("pins coding-plan and logs the switch once per change", () => {
    const logs: string[] = [];
    notePlanFallback((m) => logs.push(m));
    notePlanFallback((m) => logs.push(m));
    expect(activePlan(makeConfig())).toBe("coding-plan");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("coding-plan");
  });
});

/** Mock the billing/balance probe at the fetch level (billing envelope). */
function fetchWithBalances(balances: unknown[]): typeof fetch {
  return ((() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, code: 200, data: { balances } })),
    ))) as unknown as typeof fetch;
}

describe("watcher tick", () => {
  it("flips the effective plan from balance data", async () => {
    const cfg = makeConfig();
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithBalances([{ show_name: "w", remaining_units: 3, expires_at: Math.floor(Date.now() / 1000) + 3600 }]),
      loadCredentialImpl: (() => Promise.resolve({ apiKey: "k", jwt: "j", provider: "zai" })) as never,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });

  it("keeps coding-plan when the balance is empty", async () => {
    const cfg = makeConfig();
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithBalances([{ show_name: "w", remaining_units: 0 }]),
      loadCredentialImpl: (() => Promise.resolve({ apiKey: "k", jwt: "j", provider: "zai" })) as never,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("coding-plan");
    watcher.stop();
  });

  it("treats a missing plan JWT as no data, not as coding-plan", async () => {
    const cfg = makeConfig();
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithBalances([]),
      loadCredentialImpl: (() => Promise.resolve(null)) as never,
    });
    await watcher.tick();
    // No data yet: the optimistic start-plan assumption stands (the
    // per-request fallback corrects it if the gateway disagrees).
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });

  it("holds coding-plan through an active fallback cooldown even with balance", async () => {
    const cfg = makeConfig();
    notePlanFallback();
    expect(activePlan(cfg)).toBe("coding-plan");
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithBalances([{ show_name: "w", remaining_units: 7, expires_at: Math.floor(Date.now() / 1000) + 3600 }]),
      loadCredentialImpl: (() => Promise.resolve({ apiKey: "k", jwt: "j", provider: "zai" })) as never,
    });
    await watcher.tick();
    // The gateway may still report balance while rejecting requests; hold
    // coding-plan until the cooldown lapses so the plans do not flap.
    expect(activePlan(cfg)).toBe("coding-plan");
    watcher.stop();
  });

  it("returns to start-plan once the cooldown lapses with balance available", async () => {
    const cfg = makeConfig();
    notePlanFallback();
    __setFallbackCooldownForTests(Date.now() - 1);
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithBalances([{ show_name: "w", remaining_units: 7, expires_at: Math.floor(Date.now() / 1000) + 3600 }]),
      loadCredentialImpl: (() => Promise.resolve({ apiKey: "k", jwt: "j", provider: "zai" })) as never,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });
});

describe("sniffStartPlanRejection", () => {
  const jsonResponse = (body: string): Response =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });

  it("rejects a 200 JSON error envelope (live incident shape)", async () => {
    const r = await sniffStartPlanRejection(jsonResponse(JSON.stringify({ code: 530, msg: "insufficient balance" })));
    expect(r.rejected).toBe(true);
  });

  it("rejects success:false envelopes", async () => {
    const r = await sniffStartPlanRejection(jsonResponse(JSON.stringify({ success: false, msg: "no" })));
    expect(r.rejected).toBe(true);
  });

  it("accepts a real Anthropic message body and buffers it for passthrough", async () => {
    const body = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] });
    const r = await sniffStartPlanRejection(jsonResponse(body));
    expect(r.rejected).toBe(false);
    expect(await r.response.text()).toBe(body);
  });

  it("leaves code 3007 to the captcha retry seam", async () => {
    const r = await sniffStartPlanRejection(jsonResponse(JSON.stringify({ code: 3007, msg: "captcha verify failed" })));
    expect(r.rejected).toBe(false);
  });

  it("passes SSE responses through untouched", async () => {
    const resp = new Response("event: message_start", { status: 200, headers: { "content-type": "text/event-stream" } });
    const r = await sniffStartPlanRejection(resp);
    expect(r.rejected).toBe(false);
    expect(r.response).toBe(resp);
  });

  it("treats oversized JSON as a real payload, not an error", async () => {
    const r = await sniffStartPlanRejection(jsonResponse(JSON.stringify({ code: 1, pad: "x".repeat(70_000) })));
    expect(r.rejected).toBe(false);
  });
});

describe("fallback cooldown constant", () => {
  it("keeps the documented 10 minute cooldown", () => {
    expect(PLAN_FALLBACK_COOLDOWN_MS).toBe(600_000);
  });
});
