import { describe, it, expect, beforeEach } from "bun:test";
import {
  sendTelemetryEvent,
  ensureDailyActiveReported,
  startTelemetryHeartbeat,
  getCalendarDateInTimezone,
  resetTelemetryStateForTest,
  TELEMETRY_HEARTBEAT_INTERVAL_MS,
} from "./heartbeat.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";

const DUMMY_CRED: Credential = {
  apiKey: "test-api-key",
  provider: "zai",
  userId: "user-test-123",
  jwt: "test-jwt-token",
};

const DUMMY_CONFIG = {
  provider: "zai",
  plan: "coding-plan",
  identity: {
    appVersion: "3.15.3",
    sourceTitle: "test-heartbeat",
    refererOrigin: "https://zcode.z.ai",
    deviceMid: "88888888-4444-4444-4444-121212121212",
  },
} as ProxyConfig;

describe("telemetry heartbeat", () => {
  beforeEach(() => {
    resetTelemetryStateForTest();
  });

  it("computes calendar date correctly in target timezone", () => {
    const fixedDate = new Date("2026-10-17T12:00:00Z");
    const dateStr = getCalendarDateInTimezone("UTC", fixedDate);
    expect(dateStr).toBe("2026-10-17");
  });

  it("sendTelemetryEvent returns false when cred has no JWT", async () => {
    const credWithoutJwt: Credential = { apiKey: "key", provider: "zai" };
    const ok = await sendTelemetryEvent("app_launch", credWithoutJwt, DUMMY_CONFIG.identity);
    expect(ok).toBe(false);
  });

  it("sendTelemetryEvent sends well-formed payload and headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ code: 0, msg: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const ok = await sendTelemetryEvent("app_launch", DUMMY_CRED, DUMMY_CONFIG.identity, mockFetch);
    expect(ok).toBe(true);
    expect(capturedUrl).toBe("https://zcode.z.ai/api/v1/event/report");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-jwt-token");
    expect(headers["User-Agent"]).toContain("ZCode/3.15.3");
    expect(headers["X-Device-Mid"]).toBe("88888888-4444-4444-4444-121212121212");

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.element_name).toBe("app_launch");
    expect(body.user_id).toBe("user-test-123");
    expect(body.device_mid).toBe("88888888-4444-4444-4444-121212121212");
    expect(body.app_version).toBe("3.15.3");
    expect(body.event_region).toBe("app");
    expect(body.event_type).toBe("view");
  });

  it("ensureDailyActiveReported sends app_launch and app_daily_active on first call", async () => {
    const eventsSent: string[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      eventsSent.push(body.element_name);
      return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
    }) as unknown as typeof fetch;

    const okFirst = await ensureDailyActiveReported(DUMMY_CRED, DUMMY_CONFIG.identity, mockFetch);
    expect(okFirst).toBe(true);
    expect(eventsSent).toEqual(["app_launch", "app_daily_active"]);

    // Subsequent call on same day should deduplicate and skip network
    const okSecond = await ensureDailyActiveReported(DUMMY_CRED, DUMMY_CONFIG.identity, mockFetch);
    expect(okSecond).toBe(true);
    expect(eventsSent).toHaveLength(2);
  });

  it("startTelemetryHeartbeat ticks initially and can be stopped", async () => {
    let tickCount = 0;
    const mockFetch = (async (): Promise<Response> => {
      tickCount++;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const heartbeat = startTelemetryHeartbeat(DUMMY_CONFIG, mockFetch, async () => DUMMY_CRED);
    expect(heartbeat).toBeDefined();
    await heartbeat.tick();
    expect(tickCount).toBeGreaterThanOrEqual(1);
    heartbeat.stop();
  });

  it("TELEMETRY_HEARTBEAT_INTERVAL_MS matches 15 minutes (900_000 ms)", () => {
    expect(TELEMETRY_HEARTBEAT_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});
