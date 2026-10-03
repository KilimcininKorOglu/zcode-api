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
  startPlanAutoWatcher,
  PLAN_FALLBACK_COOLDOWN_MS,
  __resetPlanAutoStateForTests,
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

  it("falls back only for start-plan auth/quota rejections", () => {
    const cfg = makeConfig();
    expect(shouldFallbackPlan(401, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(402, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(403, "start-plan", cfg)).toBe(true);
    expect(shouldFallbackPlan(429, "start-plan", cfg)).toBe(false);
    expect(shouldFallbackPlan(500, "start-plan", cfg)).toBe(false);
    expect(shouldFallbackPlan(402, "coding-plan", cfg)).toBe(false);
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

  it("clears the fallback cooldown when balance returns", async () => {
    const cfg = makeConfig();
    notePlanFallback();
    expect(activePlan(cfg)).toBe("coding-plan");
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithBalances([{ show_name: "w", remaining_units: 7, expires_at: Math.floor(Date.now() / 1000) + 3600 }]),
      loadCredentialImpl: (() => Promise.resolve({ apiKey: "k", jwt: "j", provider: "zai" })) as never,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });
});

describe("fallback cooldown constant", () => {
  it("keeps the documented 10 minute cooldown", () => {
    expect(PLAN_FALLBACK_COOLDOWN_MS).toBe(600_000);
  });
});
