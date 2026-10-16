/**
 * Unit tests for the marketing touch auto-claimer: deliveries parsing,
 * confirmation action, deduplication, and scheduler lifecycle.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  claimActiveMarketingTouches,
  confirmMarketingTouch,
  fetchMarketingTouches,
  getClaimedCampaignIds,
  marketingConfigOf,
  startMarketingPoller,
  __resetMarketingStateForTests,
} from "./touch.js";
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    plan: "coding-plan",
    identity: {
      deviceMid: "86ca9806-3fe6-4649-8ba9-bbf07f763f01",
      appVersion: "3.15.1",
      platform: "darwin",
      sourceTitle: "cli",
      refererOrigin: "https://zcode.z.ai",
    },
    marketing: {
      enabled: true,
      origin: "https://zcode.z.ai",
      intervalSec: 1800,
    },
    ...overrides,
  } as ProxyConfig;
}

function cred(jwt?: string): Credential {
  return { apiKey: "key", secret: "sec", provider: "zai", ...(jwt ? { jwt } : {}) };
}

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

beforeEach(() => {
  __resetMarketingStateForTests();
});

describe("marketingConfigOf", () => {
  it("returns default values when config block is omitted", () => {
    const bare = { identity: {} } as ProxyConfig;
    const cfg = marketingConfigOf(bare);
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalSec).toBe(1800);
    expect(cfg.origin).toBe("https://zcode.z.ai");
  });
});

describe("fetchMarketingTouches", () => {
  it("returns empty array without a stored JWT", async () => {
    const { fetch } = mockFetch(() => new Response('{"code":0,"data":{"deliveries":[]}}'));
    const res = await fetchMarketingTouches(makeConfig(), fetch, async () => cred(undefined));
    expect(res).toEqual([]);
  });

  it("sends expected headers and parses deliveries array", async () => {
    const mockData = {
      code: 0,
      data: {
        deliveries: [
          { campaign_id: "autumn-bonus-2026", resource_position: "popup" },
          { campaign_id: "reset-gift-pack", resource_position: "banner" },
        ],
      },
    };
    const { fetch, calls } = mockFetch(() => new Response(JSON.stringify(mockData)));
    const res = await fetchMarketingTouches(makeConfig(), fetch, async () => cred("jwt-token"));
    expect(res).toHaveLength(2);
    expect(res[0].campaign_id).toBe("autumn-bonus-2026");
    expect(calls[0].headers?.authorization).toBe("Bearer jwt-token");
    expect(calls[0].headers?.["X-Device-Mid"]).toBe("86ca9806-3fe6-4649-8ba9-bbf07f763f01");
    expect(calls[0].headers?.["X-ZCode-App-Version"]).toBe("3.15.1");
    expect(calls[0].headers?.["User-Agent"]).toBe("ZCode/3.15.1");
    expect(calls[0].headers?.["HTTP-Referer"]).toBe("https://zcode.z.ai");
  });

  it("handles non-zero code or network error gracefully", async () => {
    const { fetch } = mockFetch(() => new Response('{"code":3001,"msg":"error"}'));
    const res = await fetchMarketingTouches(makeConfig(), fetch, async () => cred("jwt-token"));
    expect(res).toEqual([]);
  });
});

describe("confirmMarketingTouch", () => {
  it("POSTs campaign_id and action_type confirm", async () => {
    const { fetch, calls } = mockFetch(() => new Response('{"code":0,"msg":"success"}'));
    const ok = await confirmMarketingTouch("promo-123", makeConfig(), fetch, async () => cred("jwt-token"));
    expect(ok).toBe(true);
    expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/marketing/touch/action");
    expect(calls[0].method).toBe("POST");
    const body = JSON.parse(calls[0].body ?? "{}");
    expect(body).toEqual({ campaign_id: "promo-123", action_type: "confirm" });
    expect(calls[0].headers?.authorization).toBe("Bearer jwt-token");
  });

  it("returns false on error", async () => {
    const { fetch } = mockFetch(() => new Response('{"code":4001}', { status: 400 }));
    const ok = await confirmMarketingTouch("promo-123", makeConfig(), fetch, async () => cred("jwt-token"));
    expect(ok).toBe(false);
  });
});

describe("claimActiveMarketingTouches", () => {
  it("claims active deliveries and deduplicates previously claimed campaigns", async () => {
    const touches = {
      code: 0,
      data: {
        deliveries: [
          { campaign_id: "bonus-1" },
          { campaign_id: "bonus-2" },
        ],
      },
    };
    const { fetch } = mockFetch((url) => {
      if (url.includes("/marketing/touch/action")) {
        return new Response('{"code":0,"msg":"success"}');
      }
      return new Response(JSON.stringify(touches));
    });

    const claimedFirst = await claimActiveMarketingTouches(makeConfig(), fetch, async () => cred("jwt-token"));
    expect(claimedFirst).toEqual(["bonus-1", "bonus-2"]);
    expect(getClaimedCampaignIds().has("bonus-1")).toBe(true);
    expect(getClaimedCampaignIds().has("bonus-2")).toBe(true);

    // Second run with the same campaigns should skip claiming
    const claimedSecond = await claimActiveMarketingTouches(makeConfig(), fetch, async () => cred("jwt-token"));
    expect(claimedSecond).toEqual([]);
  });
});

describe("startMarketingPoller", () => {
  it("runs initial tick and stops cleanly", async () => {
    const { fetch } = mockFetch(() => new Response('{"code":0,"data":{"deliveries":[]}}'));
    const poller = startMarketingPoller(makeConfig(), { fetchImpl: fetch, loadCredentialImpl: async () => cred("jwt-token") });
    await poller.tick();
    poller.stop();
  });
});
