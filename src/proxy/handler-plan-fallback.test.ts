/**
 * Tests for the hybrid plan auto-switch fallback in `proxyRequest`: with
 * `planAutoSwitch` on, a start-plan 401/402/403 retries the SAME request once
 * on the coding plan (different URL, API-key auth, body re-transformed without
 * the start-plan system) and pins the effective plan for follow-up requests.
 * With the flag off, the upstream status passes through untouched.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyRequest } from "./handler.js";
import { activePlan, __resetPlanAutoStateForTests } from "../plan/auto.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { captureConsoleLog } from "./handler-debug.test.js";
import { __resetErrorLogForTests } from "./error-log.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const TEST_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: {},
  provider: "zai",
  plan: "start-plan",
  planAutoSwitch: true,
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "fallback reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

beforeEach(() => {
  __resetPlanAutoStateForTests();
  // Deterministic captcha stub: the prewarm takes tok-1, no challenge is
  // detected on 402/401/403 responses (header-only detection).
  mock.module("./captcha.js", () => ({
    detectCaptchaChallenge: (resp: Response): string | null => {
      const v = resp.headers.get("x-aliyun-captcha-verify-param");
      return v && v.trim().length > 0 ? v.trim() : null;
    },
    getCaptchaToken: async () => ({ verifyParam: "tok-1", region: "sgp" }),
    RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
  }));
});

interface RecordedCall {
  url: string;
  authorization: string | null;
  apiKey: string | null;
  body: string;
}

function makeFetch(calls: RecordedCall[]): typeof fetch {
  return Object.assign(
    (async (req: Request): Promise<Response> => {
      calls.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
        apiKey: req.headers.get("x-api-key"),
        body: await req.clone().text(),
      });
      if (req.url.includes("/api/v1/zcode-plan/")) {
        return new Response("plan quota exhausted", { status: 402 });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    { preconnect: () => {} },
  ) as typeof fetch;
}

function makeClientReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: '{"model":"glm-4.6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}',
  });
}

function makeAuth(): AuthManager {
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
  return auth;
}

describe("proxyRequest — hybrid plan auto-switch fallback", () => {
  it("retries a start-plan 402 once on the coding plan and pins coding-plan", async () => {
    const calls: RecordedCall[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, planAutoSwitch: true };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl: makeFetch(calls) });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("https://zcode.z.ai/api/v1/zcode-plan/");
    expect(calls[0].authorization).toBe("Bearer jwt-mock");
    expect(calls[1].url).toContain("https://api.z.ai/api/anthropic");
    expect(calls[1].apiKey).toBe("key-mock");
    // The coding retry must re-transform the RAW client body, not reuse the
    // start-plan body (whose injected start-plan system prompt would leak
    // into the coding-plan request).
    expect(JSON.parse(calls[0].body).system).toBeDefined();
    expect(JSON.parse(calls[1].body).system).toBeUndefined();
    expect(resp.status).toBe(200);
    // The fallback pins the effective plan for follow-up requests.
    expect(activePlan(config)).toBe("coding-plan");
  });

  it("routes the next request straight to the coding plan after a fallback", async () => {
    const config: ProxyConfig = { ...TEST_CONFIG, planAutoSwitch: true };
    const first: RecordedCall[] = [];
    await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl: makeFetch(first) });

    const second: RecordedCall[] = [];
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl: makeFetch(second) });
    expect(second).toHaveLength(1);
    expect(second[0].url).toContain("https://api.z.ai/api/anthropic");
    expect(resp.status).toBe(200);
  });

  it("retries a 200 JSON error envelope on the coding plan (live incident shape)", async () => {
    // 2026-10-03 incident: the gateway exhausted the start-plan with HTTP 200
    // + a JSON error envelope instead of an error status, so the status-based
    // fallback never fired and the client saw "0 stream events".
    const calls: RecordedCall[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({
          url: req.url,
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          body: await req.clone().text(),
        });
        if (req.url.includes("/api/v1/zcode-plan/")) {
          return new Response(JSON.stringify({ code: 530, msg: "insufficient balance" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG, planAutoSwitch: true };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/api/v1/zcode-plan/");
    expect(calls[1].url).toContain("https://api.z.ai/api/anthropic");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id?: string };
    expect(body.id).toBe("msg_1");
    expect(activePlan(config)).toBe("coding-plan");
  });

  it("passes a valid 200 start-plan response through without falling back", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({
          url: req.url,
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          body: await req.clone().text(),
        });
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG, planAutoSwitch: true };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v1/zcode-plan/");
    expect(resp.status).toBe(200);
    expect(activePlan(config)).toBe("start-plan");
  });

  it("passes a start-plan 402 through untouched when planAutoSwitch is off", async () => {
    const calls: RecordedCall[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, planAutoSwitch: false };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl: makeFetch(calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://zcode.z.ai/api/v1/zcode-plan/");
    expect(resp.status).toBe(402);
    expect(activePlan(config)).toBe("start-plan");
  });

  it("falls back to the coding plan when the start-plan gateway 504s (live outage shape)", async () => {
    // 2026-10-04 outage: the start-plan gateway answered every request with
    // LB 504@60s/502@30s for ~10 minutes; the plan fallback only knew
    // 401/402/403, so the client ate every failure.
    const calls: RecordedCall[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({
          url: req.url,
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          body: await req.clone().text(),
        });
        if (req.url.includes("/api/v1/zcode-plan/")) {
          return new Response("gateway timeout", { status: 504 });
        }
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG, planAutoSwitch: true };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl });

    // Two start-plan attempts (dispatch-level gateway retry) + the coding retry.
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("/api/v1/zcode-plan/");
    expect(calls[1].url).toContain("/api/v1/zcode-plan/");
    expect(calls[2].url).toContain("https://api.z.ai/api/anthropic");
    expect(calls[2].apiKey).toBe("key-mock");
    expect(resp.status).toBe(200);
    expect(activePlan(config)).toBe("coding-plan");
  });

  it("retries a coding-plan gateway 502 once before surfacing it", async () => {
    // The dispatch-level gateway retry is independent of planAutoSwitch: a
    // coding-plan LB blip (502@30s rows in the live logs) gets one clean
    // resend, and only a repeated failure reaches the client.
    let call = 0;
    const calls: RecordedCall[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({
          url: req.url,
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          body: await req.clone().text(),
        });
        call += 1;
        if (call === 1) return new Response("bad gateway", { status: 502 });
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG, plan: "coding-plan", planAutoSwitch: false };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("https://api.z.ai/api/anthropic");
    expect(calls[1].url).toContain("https://api.z.ai/api/anthropic");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id?: string };
    expect(body.id).toBe("msg_1");
  });

  it("passes a repeated gateway 502 through after the single retry", async () => {
    // A sustained outage must not multiply the client's wait: exactly one
    // retry, then the upstream failure passes through untouched.
    const calls: RecordedCall[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({
          url: req.url,
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          body: await req.clone().text(),
        });
        return new Response("bad gateway", { status: 502 });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG, plan: "coding-plan", planAutoSwitch: false };
    const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl });

    expect(calls).toHaveLength(2);
    expect(resp.status).toBe(502);
  });

  it("skips the gateway retry when the client already hung up (live 2026-10-05 signature)", async () => {
    // The two silent live 502 rows: the client disconnected while the fast
    // LB 502 was in flight, so the retry is skipped — one upstream hit,
    // status passed through, nothing retried for a caller that is gone.
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({
          url: req.url,
          authorization: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          body: await req.clone().text(),
        });
        // The client hangs up while the 502 is in flight: by the time the
        // response is processed, the request signal is already aborted.
        controller.abort();
        return new Response("bad gateway", { status: 502 });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG, plan: "coding-plan", planAutoSwitch: false };
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}',
      signal: controller.signal,
    });
    const resp = await proxyRequest(clientReq, "anthropic", { config, auth: makeAuth(), fetchImpl });

    expect(calls).toHaveLength(1);
    expect(resp.status).toBe(502);
  });

  it("logs the reason when the client hung up before the first connect", async () => {
    // The other silent live-502 producer: the client aborted while the
    // request was still being read/transformed, so the ladder's pre-flight
    // abort check throws before any upstream attempt and no retry line
    // exists. The catch site must still say why.
    const calls: RecordedCall[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, plan: "coding-plan", planAutoSwitch: false };
    const abortedReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}',
      signal: AbortSignal.abort(),
    });
    const lines = await captureConsoleLog(async () => {
      const resp = await proxyRequest(abortedReq, "anthropic", { config, auth: makeAuth(), fetchImpl: makeFetch(calls) });
      expect(resp.status).toBe(502);
    });
    expect(calls).toHaveLength(0);
    expect(lines.some((line) => line.includes("client gone before upstream connect, not retrying"))).toBe(true);
  });

  it("logs the reason when the transport dies after the request was written", async () => {
    // postWrite failures are never retried by design (PR #34 review): the
    // request may have been processed. The 502 row must still carry a line.
    const err = new Error("socket closed unexpectedly");
    (err as { postWrite?: boolean }).postWrite = true;
    const fetchImpl = Object.assign(
      (async (_request: Request): Promise<Response> => {
        throw err;
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const calls: RecordedCall[] = [];
    void calls;
    const config: ProxyConfig = { ...TEST_CONFIG, plan: "coding-plan", planAutoSwitch: false };
    const lines = await captureConsoleLog(async () => {
      const resp = await proxyRequest(makeClientReq(), "anthropic", { config, auth: makeAuth(), fetchImpl });
      expect(resp.status).toBe(502);
    });
    expect(lines.some((line) => line.includes("upstream connection lost after the request was written, not retried"))).toBe(true);
  });

  it("records gateway failures in the persistent error log", async () => {
    // The operator-facing errors.log (next to the config file) must carry the
    // failure reason AND the request-level row for every client-visible 502.
    const logDir = mkdtempSync(join(tmpdir(), "errlog-handler-"));
    const logPath = join(logDir, "errors.log");
    process.env.ZCODE_ERROR_LOG = logPath;
    __resetErrorLogForTests();
    try {
      const calls: RecordedCall[] = [];
      const fetchImpl = Object.assign(
        (async (req: Request): Promise<Response> => {
          calls.push({
            url: req.url,
            authorization: req.headers.get("authorization"),
            apiKey: req.headers.get("x-api-key"),
            body: await req.clone().text(),
          });
          return new Response("bad gateway", { status: 502, headers: { "x-request-id": "gw-req-42" } });
        }) as typeof fetch,
        { preconnect: () => {} },
      ) as typeof fetch;
      const config: ProxyConfig = { ...TEST_CONFIG, plan: "coding-plan", planAutoSwitch: false };
      const resp = await proxyRequest(makeClientReq({ "x-request-id": "client-req-7" }), "anthropic", { config, auth: makeAuth(), fetchImpl });
      expect(resp.status).toBe(502);

      // The failure entries must carry the correlation ids: the gateway's own
      // x-request-id and the ids the client sent, so a client-side error can
      // be matched against this file without guesswork.
      const entries = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; status?: number; reqId?: string; clientRequestId?: string; clientSessionId?: string; upstreamRequestId?: string });
      const retry = entries.find((e) => e.kind === "upstream_gateway_retry" && e.status === 502);
      expect(retry?.upstreamRequestId).toBe("gw-req-42");
      expect(retry?.clientRequestId).toBe("client-req-7");
      const row = entries.find((e) => e.kind === "request_error" && e.status === 502);
      expect(row?.reqId).toMatch(/^[0-9a-f]{4}-#\d{3,}$/);
      expect(row?.clientRequestId).toBe("client-req-7");
      expect(row?.upstreamRequestId).toBe("gw-req-42");
      expect(calls).toHaveLength(2);
    } finally {
      delete process.env.ZCODE_ERROR_LOG;
      __resetErrorLogForTests();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
