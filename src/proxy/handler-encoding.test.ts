/**
 * End-to-end tests for the content-encoding safety nets in `proxyRequest`:
 * the passthrough response net (upstream compressed anyway, client cannot or
 * can decode) and request-body inflation (clients that SEND compressed
 * bodies, including the ambiguous `deflate`).
 */
import { describe, it, expect } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { compressTestBytes } from "./inflate.test.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const TEST_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: {},
  provider: "zai",
  plan: "coding-plan",
  planAutoSwitch: false,
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
  id: "msg_enc",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "encoded reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

const makeAuth = (): AuthManager => {
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
  return auth;
};


function makeClientReq(headers: Record<string, string>, body?: BodyInit): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers,
    body: body ?? '{"model":"glm-4.6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}',
  });
}

function encodedUpstream(wire: Uint8Array, encoding: string): typeof fetch {
  return Object.assign(
    (async (_request: Request) => new Response(wire as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/json", ...(encoding ? { "content-encoding": encoding } : {}) },
    })) as typeof fetch,
    { preconnect: () => {} },
  ) as typeof fetch;
}

describe("proxyRequest — passthrough content-encoding safety net", () => {
  it("inflates a brotli body for a client that cannot decode br", async () => {
    const wire = await compressTestBytes(new TextEncoder().encode(ANTHROPIC_OK), "brotli");
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "accept-encoding": "gzip" }),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(wire, "br") },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(await resp.text()).toBe(ANTHROPIC_OK);
  });

  it("forwards a brotli body untouched when the client accepts br", async () => {
    const wire = await compressTestBytes(new TextEncoder().encode(ANTHROPIC_OK), "brotli");
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "accept-encoding": "gzip, deflate, br" }),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(wire, "br") },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("br");
    const body = new Uint8Array(await resp.arrayBuffer());
    expect(Buffer.from(body).equals(Buffer.from(wire))).toBe(true);
  });

  it("still inflates gzip for an identity-only client (the Tauri case)", async () => {
    const wire = await compressTestBytes(new TextEncoder().encode(ANTHROPIC_OK), "gzip");
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "accept-encoding": "identity" }),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(wire, "gzip") },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await resp.text()).id).toBe("msg_enc");
  });

  it("forwards an inflatable-to-us unknown coding raw with its truthful header", async () => {
    // A coding neither the client accepts nor we can inflate must NOT be
    // silently stripped — the raw body goes out with the header intact so the
    // failure is visible and diagnosed at the client, not hidden.
    const wire = new TextEncoder().encode("pretend-compressed");
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "accept-encoding": "gzip" }),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(wire, "made-up") },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("made-up");
    expect(new TextDecoder().decode(new Uint8Array(await resp.arrayBuffer()))).toBe("pretend-compressed");
  });

  it("treats content-encoding: identity as not encoded", async () => {
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "accept-encoding": "identity" }),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(new TextEncoder().encode(ANTHROPIC_OK), "identity") },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-encoding")).toBe("identity");
    expect(await resp.text()).toBe(ANTHROPIC_OK);
  });
});

describe("proxyRequest — compressed request bodies", () => {
  it.each([
    ["gzip", "gzip"],
    ["deflate", "deflate"],
    ["deflate", "deflate-raw"],
    ["br", "brotli"],
  ])("inflates a %s-labelled request body before JSON parsing", async (labelled, format) => {
    const seen: string[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        seen.push(await req.clone().text());
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const wire = await compressTestBytes(new TextEncoder().encode('{"model":"glm-4.6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'), format);
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "content-encoding": labelled }, wire as unknown as BodyInit),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl },
    );
    expect(resp.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]).model).toBe("glm-4.6");
  });

  it("answers corrupt compressed bodies with the encoding in the error", async () => {
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "content-encoding": "deflate" }, "this-is-not-deflate"),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(new TextEncoder().encode(ANTHROPIC_OK), "") },
    );
    expect(resp.status).toBe(400);
    const body = JSON.parse(await resp.text()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("content-encoding: deflate");
  });

  it("answers a coding this runtime cannot inflate by naming it", async () => {
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "content-encoding": "made-up" }, "whatever"),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl: encodedUpstream(new TextEncoder().encode(ANTHROPIC_OK), "") },
    );
    expect(resp.status).toBe(400);
    const body = JSON.parse(await resp.text()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("made-up");
  });

  it("passes identity-labelled bodies through untouched", async () => {
    const seen: string[] = [];
    const fetchImpl = Object.assign(
      (async (req: Request): Promise<Response> => {
        seen.push(await req.clone().text());
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const config: ProxyConfig = { ...TEST_CONFIG };
    const resp = await proxyRequest(
      makeClientReq({ "content-type": "application/json", "content-encoding": "identity" }),
      "anthropic",
      { config, auth: makeAuth(), fetchImpl },
    );
    expect(resp.status).toBe(200);
    expect(JSON.parse(seen[0]).model).toBe("glm-4.6");
  });
});
