/**
 * Tests for the two resilience behaviors added after the PR #34 review:
 *
 * 1. In-body captcha challenge detection: a start-plan upstream response with
 *    HTTP 400 + {"code":3007,...} in the JSON body (no captcha header) must
 *    be treated as a captcha challenge and retried with a fresh token.
 * 2. Connect-retry freshness: after a connect-level failure, the retried
 *    dispatch must receive a FRESH Request. Review follow-up #1 (PR #34):
 *    a `req.bodyUsed === false` assertion is vacuous in a mock (mock fetch
 *    never consumes the body), so freshness is pinned by OBJECT IDENTITY —
 *    the second call must receive a different Request instance.
 *
 * Both tests use the start-plan path with an injected captcha module via
 * `mock.module("./captcha.js")` (same technique as captcha-pool.test.ts).
 */
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { SUBAGENT_PREFIX } from "./trace-headers.js";

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
  clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalSec: 300, cooldownMs: 600000, planId: "" },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_resilience",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "resilience reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

describe("proxyRequest — start-plan resilience (PR #34 review P1/P3)", () => {
  it("retries an in-body 3007 captcha challenge with a fresh token", async () => {
    // Mock the captcha module: config enabled, token take returns distinct
    // tokens per call so we can assert the retry used a FRESH token.
    let tokenSeq = 0;
    mock.module("./captcha.js", () => ({
      detectCaptchaChallenge: (resp: Response): string | null => {
        const v = resp.headers.get("x-aliyun-captcha-verify-param");
        return v && v.trim().length > 0 ? v.trim() : null;
      },
      getCaptchaToken: async (_appVersion: string) => {
        tokenSeq += 1;
        return { verifyParam: `tok-${tokenSeq}`, region: "sgp" };
      },
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
    }));

    // Upstream: first call = HTTP 400 with {"code":3007} in the body (no
    // captcha header), second call = success. The mock also records the
    // captcha header of each call so we can assert the retry used a FRESH
    // token (tok-2, not the consumed tok-1).
    const seenCaptchaHeaders: (string | null)[] = [];
    let calls = 0;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      if (req.url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: true } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      calls += 1;
      seenCaptchaHeaders.push(req.headers.get("x-aliyun-captcha-verify-param"));
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager();
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    const resp = await proxyRequest(clientReq, "openai", { config: TEST_CONFIG, auth, fetchImpl: fetchMock as any });

    // The in-body 3007 challenge was detected and retried with a fresh token.
    expect(calls).toBe(2);
    expect(seenCaptchaHeaders[0]).toBe("tok-1");
    expect(seenCaptchaHeaders[1]).toBe("tok-2");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });

  it("retries a connect failure with a FRESH Request (identity-pinned)", async () => {
    // Upstream: first call = connect-level failure (the bug shape), second
    // call = success. Review follow-up #1 (PR #34): a mock fetch never
    // consumes the Request body, so a `req.bodyUsed === false` assertion is
    // vacuous — it passes even if the handler re-dispatches the SAME Request
    // object. Pin freshness by OBJECT IDENTITY instead: the second call must
    // receive a different Request instance than the first.
    let calls = 0;
    let firstReq: Request | null = null;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        firstReq = req;
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      // The freshness assertion: re-dispatching the SAME Request object
      // would fail this identity check.
      expect(firstReq).not.toBeNull();
      expect(req).not.toBe(firstReq);
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const auth = new AuthManager();
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    const resp = await proxyRequest(clientReq, "openai", { config: TEST_CONFIG, auth, fetchImpl: fetchMock as any });

    // The connect failure was retried with a FRESH Request (identity check
    // inside the mock passed).
    expect(calls).toBe(2);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });
});

/**
 * The gateway cross-checks `x-zcode-session-type` against the system shape: a
 * start-plan request carrying a client system prompt takes the 2-block
 * customSystemPrompt path, which must ride a subagent session identity
 * (405/3012 "unusual activity" otherwise — live-verified 2026-10-23).
 */
describe("proxyRequest — start-plan custom system takes the subagent identity", () => {
  beforeAll(() => {
    mock.module("./captcha.js", () => ({
      getCaptchaToken: async () => ({ verifyParam: "cap", region: "sgp" }),
      detectCaptchaChallenge: () => null,
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
    }));
  });

  /** Captures the upstream Request and answers with a plain Anthropic message. */
  function captureContext() {
    const ctx: { req?: Request } = {};
    const fetchImpl = (async (req: Request) => {
      ctx.req = req;
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { ctx, fetchImpl };
  }

  function messagesBody(system: unknown): string {
    return JSON.stringify({ model: "glm-4.6", max_tokens: 16, system, messages: [{ role: "user", content: "hi" }] });
  }

  it("sends 2 system blocks and derives the subagent session type", async () => {
    const { ctx, fetchImpl } = captureContext();
    const auth = new AuthManager();
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody([{ type: "text", text: "User rule" }]),
    });

    const resp = await proxyRequest(clientReq, "anthropic", { config: TEST_CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(200);
    expect(ctx.req!.headers.get("x-zcode-session-type")).toBe("subagent");
    // observe mode does not forward the session id; when it is forwarded the
    // internal subagent prefix never reaches the wire.
    const wireSessionId = ctx.req!.headers.get("x-session-id");
    expect(wireSessionId === null || !wireSessionId.startsWith(SUBAGENT_PREFIX)).toBe(true);

    const upstreamBody = await ctx.req!.clone().json() as { system: Array<{ text: string }> };
    expect(upstreamBody.system).toHaveLength(2);
    expect(upstreamBody.system[1].text).toBe("\nUser rule");
  });

  it("synthesizes the subagent identity when client identity is off", async () => {
    const { ctx, fetchImpl } = captureContext();
    const auth = new AuthManager();
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody("User rule"),
    });
    const config: ProxyConfig = { ...TEST_CONFIG, clientIdentity: { ...TEST_CONFIG.clientIdentity, mode: "off" } };

    const resp = await proxyRequest(clientReq, "anthropic", { config, auth, fetchImpl });
    expect(resp.status).toBe(200);
    expect(ctx.req!.headers.get("x-zcode-session-type")).toBe("subagent");
    const wireSessionId = ctx.req!.headers.get("x-session-id");
    expect(wireSessionId).toBeDefined();
    expect(wireSessionId!.startsWith(SUBAGENT_PREFIX)).toBe(false);
  });

  it("keeps the main identity and the 3-block chain without a client system prompt", async () => {
    const { ctx, fetchImpl } = captureContext();
    const auth = new AuthManager();
    auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
    const clientReq = new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody(undefined),
    });

    const resp = await proxyRequest(clientReq, "anthropic", { config: TEST_CONFIG, auth, fetchImpl });
    expect(resp.status).toBe(200);
    expect(ctx.req!.headers.get("x-zcode-session-type")).toBe("main");
    const upstreamBody = await ctx.req!.clone().json() as { system: unknown[] };
    expect(upstreamBody.system).toHaveLength(3);
  });
});
