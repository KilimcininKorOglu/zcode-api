/**
 * Tests for the configurable plan auto-switch: the balance rule, per-request
 * plan resolution, the fallback seam, and the background watcher's tick.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  activePlan,
  codingUsable,
  decidePlan,
  describeCodingWindow,
  formatDuration,
  formatPollLine,
  hasUsableBalance,
  nextPlanInPriority,
  notePlanFallback,
  planPollIntervalMsOf,
  planPriorityOf,
  planWatchedLimitsOf,
  readableReset,
  shouldFallbackPlan,
  sniffStartPlanRejection,
  startPlanAutoWatcher,
  PLAN_FALLBACK_COOLDOWN_MS,
  __resetPlanAutoStateForTests,
  __setFallbackCooldownForTests,
} from "./auto.js";
import type { QuotaBalanceEntry } from "../server/routes-quota.js";
import type { ProxyConfig } from "../config/types.js";

/** Minimal config fixture — the watcher reads plan*, claim.origin and providers.*.openaiBase. */
function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    plan: "start-plan",
    planAutoSwitch: true,
    claim: { origin: "https://zcode.z.ai" },
    identity: { appVersion: "test" },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
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

describe("config accessors", () => {
  it("fall back to the shipped defaults when the keys are absent", () => {
    expect(planPriorityOf(makeConfig())).toEqual(["start-plan", "coding-plan"]);
    expect(planWatchedLimitsOf(makeConfig(), "coding-plan")).toEqual(["TIME_LIMIT", "WEEK_LIMIT"]);
    expect(planWatchedLimitsOf(makeConfig(), "start-plan")).toEqual(["BALANCE"]);
    expect(planPollIntervalMsOf(makeConfig())).toBe(30_000);
  });

  it("read the configured overrides", () => {
    const cfg = makeConfig({
      planPriority: ["coding-plan", "start-plan"],
      planSwitchRules: { "coding-plan": { limits: ["WEEK_LIMIT"] }, "start-plan": { limits: ["BALANCE"] } },
      planPollIntervalSec: 5,
    });
    expect(planPriorityOf(cfg)).toEqual(["coding-plan", "start-plan"]);
    expect(planWatchedLimitsOf(cfg, "coding-plan")).toEqual(["WEEK_LIMIT"]);
    expect(planPollIntervalMsOf(cfg)).toBe(5_000);
  });
});

describe("nextPlanInPriority", () => {
  it("returns the next entry and null for the last or unlisted plan", () => {
    expect(nextPlanInPriority(["start-plan", "coding-plan"], "start-plan")).toBe("coding-plan");
    expect(nextPlanInPriority(["start-plan", "coding-plan"], "coding-plan")).toBeNull();
    expect(nextPlanInPriority(["coding-plan"], "coding-plan")).toBeNull();
    expect(nextPlanInPriority(["start-plan"], "coding-plan")).toBeNull();
  });
});

describe("decidePlan", () => {
  it("serves the first usable plan in priority order", () => {
    expect(decidePlan(["coding-plan", "start-plan"], { "coding-plan": true, "start-plan": true })).toBe("coding-plan");
    expect(decidePlan(["coding-plan", "start-plan"], { "coding-plan": false, "start-plan": true })).toBe("start-plan");
  });

  it("parks on the head of the list when nothing is usable", () => {
    expect(decidePlan(["coding-plan", "start-plan"], { "coding-plan": false, "start-plan": false })).toBe("coding-plan");
  });

  it("never leaves a single-tier priority", () => {
    expect(decidePlan(["coding-plan"], { "coding-plan": false, "start-plan": true })).toBe("coding-plan");
  });
});

describe("codingUsable", () => {
  it("is false only when a watched window reports zero remaining", () => {
    const limits = [
      { type: "TIME_LIMIT", remaining: 0 },
      { type: "WEEK_LIMIT", remaining: 500 },
    ];
    expect(codingUsable(limits, ["TIME_LIMIT", "WEEK_LIMIT"])).toBe(false);
    expect(codingUsable(limits, ["WEEK_LIMIT"])).toBe(true);
  });

  it("treats absent or number-less rows as usable (fail-open)", () => {
    expect(codingUsable([], ["TIME_LIMIT", "WEEK_LIMIT"])).toBe(true);
    expect(codingUsable([{ type: "TIME_LIMIT" }], ["TIME_LIMIT"])).toBe(true);
    // No remaining field: used/total estimates exhaustion.
    expect(codingUsable([{ type: "TIME_LIMIT", used: 120, total: 120 }], ["TIME_LIMIT"])).toBe(false);
  });
});

describe("activePlan", () => {
  it("returns config.plan untouched when planAutoSwitch is off", () => {
    const cfg = makeConfig({ plan: "start-plan", planAutoSwitch: false });
    expect(activePlan(cfg)).toBe("start-plan");
  });

  it("assumes the priority head before the first poll", () => {
    expect(activePlan(makeConfig())).toBe("start-plan");
    expect(activePlan(makeConfig({ planPriority: ["coding-plan", "start-plan"] }))).toBe("coding-plan");
  });

  it("falls to the second plan during a cooldown before any poll data", () => {
    __setFallbackCooldownForTests(Date.now() + 60_000);
    expect(activePlan(makeConfig())).toBe("coding-plan");
  });

  it("follows the watcher's effective plan", () => {
    notePlanFallback("start-plan", "coding-plan");
    expect(activePlan(makeConfig())).toBe("coding-plan");
  });
});

describe("shouldFallbackPlan", () => {
  it("falls back for start-plan auth/quota rejections and exhaustion 429s, with or without planAutoSwitch", () => {
    // The fallback repairs a rejected plan in one request whether the plan
    // was picked by the watcher or by hand (live 2026-10-06: flag off,
    // hand-pinned start-plan, gateway 200 + quota envelope passed through).
    expect(shouldFallbackPlan(401, "start-plan")).toBe(true);
    expect(shouldFallbackPlan(402, "start-plan")).toBe(true);
    expect(shouldFallbackPlan(403, "start-plan")).toBe(true);
    // A start-plan 429 is plan exhaustion, not load: the auto-claim loop kept
    // refreshing balances while every request was rejected (live 2026-10-05).
    expect(shouldFallbackPlan(429, "start-plan")).toBe(true);
    expect(shouldFallbackPlan(502, "start-plan")).toBe(true);
    expect(shouldFallbackPlan(504, "start-plan")).toBe(true);
    expect(shouldFallbackPlan(500, "start-plan")).toBe(false);
    expect(shouldFallbackPlan(503, "start-plan")).toBe(false);
  });

  it("falls back only on the coding-plan exhaustion 429", () => {
    // The watched TIME_LIMIT/WEEK_LIMIT windows emptying surface as 429s from
    // the ultra gateway; 502/504 are absorbed by the dispatch-level gateway
    // retry and 401/402 are credential problems a plan switch cannot fix.
    expect(shouldFallbackPlan(429, "coding-plan")).toBe(true);
    expect(shouldFallbackPlan(402, "coding-plan")).toBe(false);
    expect(shouldFallbackPlan(403, "coding-plan")).toBe(false);
    expect(shouldFallbackPlan(500, "coding-plan")).toBe(false);
    expect(shouldFallbackPlan(502, "coding-plan")).toBe(false);
  });
});

describe("notePlanFallback", () => {
  it("pins the target plan and logs the switch once per change", () => {
    const logs: string[] = [];
    notePlanFallback("start-plan", "coding-plan", (m) => logs.push(m));
    notePlanFallback("start-plan", "coding-plan", (m) => logs.push(m));
    expect(activePlan(makeConfig())).toBe("coding-plan");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("coding-plan");
  });
});

interface PlaneProbe {
  balances?: unknown[];
  balanceFail?: boolean;
  coding?: { level?: string; limits?: unknown[] };
  codingFail?: boolean;
}

/** Mock both quota planes at the fetch level, routed by URL (billing vs monitor). */
function fetchWithPlanes(probe: PlaneProbe): typeof fetch {
  return ((async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/monitor/usage/quota/limit")) {
      if (probe.codingFail) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({
        success: true,
        code: 200,
        data: { level: probe.coding?.level ?? "max", limits: probe.coding?.limits ?? [] },
      }));
    }
    if (url.includes("/billing/balance")) {
      if (probe.balanceFail) {
        return new Response(JSON.stringify({ success: false, code: 3012, msg: "jwt expired" }));
      }
      return new Response(JSON.stringify({ success: true, code: 200, data: { balances: probe.balances ?? [] } }));
    }
    return new Response("unexpected url", { status: 404 });
  })) as unknown as typeof fetch;
}

const loadLive = (() => Promise.resolve({ apiKey: "k", jwt: "j", provider: "zai" })) as never;
const loadNone = (() => Promise.resolve(null)) as never;

describe("watcher tick", () => {
  const usableBalance = [{ show_name: "w", remaining_units: 3, expires_at: Math.floor(Date.now() / 1000) + 3600 }];
  const fullCoding = { limits: [{ type: "TIME_LIMIT", remaining: 3894 }, { type: "WEEK_LIMIT", remaining: 500 }] };
  const emptyCoding = { limits: [{ type: "TIME_LIMIT", remaining: 0 }, { type: "WEEK_LIMIT", remaining: 500 }] };

  it("keeps start-plan while its balance holds (default priority)", async () => {
    const cfg = makeConfig();
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({ balances: usableBalance, coding: fullCoding }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });

  it("moves coding-first traffic to start-plan when a watched window empties", async () => {
    // The requested scenario: coding plan first; the 5h TIME_LIMIT hitting 0
    // flips the watcher to start-plan while the weekly window still holds.
    const cfg = makeConfig({ planPriority: ["coding-plan", "start-plan"] });
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({ balances: usableBalance, coding: emptyCoding }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });

  it("stays on the priority head while both planes hold quota", async () => {
    const cfg = makeConfig({ planPriority: ["coding-plan", "start-plan"] });
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({ balances: usableBalance, coding: fullCoding }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("coding-plan");
    watcher.stop();
  });

  it("only watches the configured windows (planSwitchRules)", async () => {
    // A rule narrowed to WEEK_LIMIT must ignore an emptied TIME_LIMIT.
    const cfg = makeConfig({
      planPriority: ["coding-plan", "start-plan"],
      planSwitchRules: { "coding-plan": { limits: ["WEEK_LIMIT"] }, "start-plan": { limits: ["BALANCE"] } },
    });
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({
        balances: usableBalance,
        coding: { limits: [{ type: "TIME_LIMIT", remaining: 0 }, { type: "WEEK_LIMIT", remaining: 500 }] },
      }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("coding-plan");
    watcher.stop();
  });

  it("parks on the priority head when every plane reports empty", async () => {
    const cfg = makeConfig();
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({ balances: [{ show_name: "w", remaining_units: 0 }], coding: emptyCoding }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });

  it("treats a missing credential as no data, not as exhaustion", async () => {
    const cfg = makeConfig();
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({}),
      loadCredentialImpl: loadNone,
    });
    await watcher.tick();
    // No data yet: the optimistic priority-head assumption stands (the
    // per-request fallback corrects it if the gateway disagrees).
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });

  it("holds the current plan through an active fallback cooldown", async () => {
    const cfg = makeConfig({ planPriority: ["coding-plan", "start-plan"] });
    notePlanFallback("start-plan", "coding-plan");
    expect(activePlan(cfg)).toBe("coding-plan");
    const watcher = startPlanAutoWatcher(cfg, {
      // start-plan reports balance again, but the gateway may still be
      // rejecting it — hold the plan until the cooldown lapses.
      fetchImpl: fetchWithPlanes({ balances: usableBalance, coding: emptyCoding }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("coding-plan");
    watcher.stop();
  });

  it("reassesses once the cooldown lapses", async () => {
    const cfg = makeConfig({ planPriority: ["coding-plan", "start-plan"] });
    notePlanFallback("start-plan", "coding-plan");
    __setFallbackCooldownForTests(Date.now() - 1);
    const watcher = startPlanAutoWatcher(cfg, {
      fetchImpl: fetchWithPlanes({ balances: usableBalance, coding: emptyCoding }),
      loadCredentialImpl: loadLive,
    });
    await watcher.tick();
    expect(activePlan(cfg)).toBe("start-plan");
    watcher.stop();
  });
});

describe("poll line formatting", () => {
  const now = 1_800_000_000_000;

  it("formats durations and reset countdowns (seconds and ms both seen upstream)", () => {
    expect(formatDuration(3 * 3600_000 + 10 * 60_000)).toBe("3h 10m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(6 * 86_400_000 + 2 * 3600_000)).toBe("6d 2h");
    expect(readableReset((now + 3 * 3600_000 + 10 * 60_000) / 1000, now)).toBe("in 3h 10m");
    expect(readableReset(now + 60_000, now)).toBe("in 1m");
    expect(readableReset(now - 1, now)).toBe("overdue");
    expect(readableReset(undefined, now)).toBeUndefined();
  });

  it("describes windows percent-first in the requested shape", () => {
    expect(describeCodingWindow({ type: "TOKENS_LIMIT", percentage: 30, nextResetTime: now + 3.1 * 3600_000 }, "used", now)).toBe(
      "%30 used, resets in 3h 6m",
    );
    expect(describeCodingWindow({ type: "TIME_LIMIT", percentage: 29, nextResetTime: now + 3.1 * 3600_000 }, "left", now)).toBe(
      "%71 left, resets in 3h 6m",
    );
    // No percentage: used/total arithmetic, then a plain remaining count.
    expect(describeCodingWindow({ type: "TIME_LIMIT", used: 12, total: 120 }, "left", now)).toBe("%90 left");
    // Junk total (1 with remaining 71) is rejected; plain remaining survives.
    expect(describeCodingWindow({ type: "TIME_LIMIT", remaining: 71, total: 1 }, "left", now)).toBe("71 left");
    expect(describeCodingWindow({ type: "TOKENS_LIMIT" }, "used", now)).toBe("no numbers");
  });

  it("renders the full probe line in the fixed window order and stays silent when nothing was observed", () => {
    const line = formatPollLine(
      "coding-plan",
      { ok: true, balances: [{ showName: "GLM-5.3-Flash", remainingUnits: 55543454, totalUnits: 100000000, usedUnits: 44456546 }] },
      {
        ok: true,
        level: "lite",
        limits: [
          { type: "TOKENS_LIMIT", percentage: 30, nextResetTime: now + 3 * 3600_000 },
          { type: "TIME_LIMIT", percentage: 29, nextResetTime: now + 18 * 86_400_000 + 2 * 3600_000 },
        ],
      },
      now,
    );
    // TOKENS_LIMIT = 5h Window (used share), TIME_LIMIT = Monthly Limit
    // (remaining share); WEEK_LIMIT absent upstream → absent from the line.
    expect(line).toBe(
      "plan auto-switch: serving coding-plan | 5h Window: %30 used, resets in 3h | Monthly Limit: %71 left, resets in 18d 2h | Start Plan Tokens: 55.543.454 / 100.000.000 tokens left",
    );
    expect(formatPollLine("coding-plan", null, null, now)).toBeNull();
    expect(formatPollLine("coding-plan", { ok: false, balances: [], error: "balance: 3001 parameter error" }, null, now)).toBeNull();
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
