/**
 * End-to-end tests for batch-as-stream: batch client requests go upstream
 * with `stream: true` and the SSE is reassembled into the single JSON the
 * client expects (the upstream gateway kills silent non-streaming requests
 * past ~180s). Covers the Anthropic passthrough path, the OpenAI translated
 * path, the flag kill-switch and streaming-client passthrough.
 */
import { describe, it, expect } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";

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
  batchAsStream: true,
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

const makeAuth = (): AuthManager => {
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai", jwt: "jwt-mock" });
  return auth;
};

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_bs","type":"message","role":"assistant","model":"glm-4.6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed reply"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const SSE_ERROR = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream overloaded"}}\n\n';

interface RecordedCall { url: string; body: string }

function sseFetch(calls: RecordedCall[], wire = SSE): typeof fetch {
  return Object.assign(
    (async (req: Request): Promise<Response> => {
      calls.push({ url: req.url, body: await req.clone().text() });
      return new Response(wire, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
    { preconnect: () => {} },
  ) as typeof fetch;
}

function makeClientReq(body: unknown, format: "anthropic" | "openai"): Request {
  const path = format === "openai" ? "/v1/chat/completions" : "/v1/messages";
  return new Request(`http://localhost:8080${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("proxyRequest — batch-as-stream (Anthropic passthrough)", () => {
  it("sends stream:true upstream and reassembles the batch JSON", async () => {
    const calls: RecordedCall[] = [];
    const resp = await proxyRequest(
      makeClientReq({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, "anthropic"),
      "anthropic",
      { config: { ...TEST_CONFIG }, auth: makeAuth(), fetchImpl: sseFetch(calls) },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const body = (await resp.json()) as { content: Array<{ text: string }>; usage: { output_tokens: number } };
    expect(body.content[0].text).toBe("streamed reply");
    expect(body.usage.output_tokens).toBe(5);
    expect(JSON.parse(calls[0].body).stream).toBe(true);
  });

  it("leaves the old wire when batchAsStream is off", async () => {
    const calls: RecordedCall[] = [];
    const jsonFetch = Object.assign(
      (async (req: Request): Promise<Response> => {
        calls.push({ url: req.url, body: await req.clone().text() });
        return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "glm-4.6", content: [{ type: "text", text: "plain" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      { preconnect: () => {} },
    ) as typeof fetch;
    const resp = await proxyRequest(
      makeClientReq({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, "anthropic"),
      "anthropic",
      { config: { ...TEST_CONFIG, batchAsStream: false }, auth: makeAuth(), fetchImpl: jsonFetch },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].body).stream).toBeUndefined();
  });

  it("passes a true streaming client through as SSE", async () => {
    const calls: RecordedCall[] = [];
    const resp = await proxyRequest(
      makeClientReq({ model: "glm-4.6", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }, "anthropic"),
      "anthropic",
      { config: { ...TEST_CONFIG }, auth: makeAuth(), fetchImpl: sseFetch(calls) },
    );
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    expect(JSON.parse(calls[0].body).stream).toBe(true);
  });

  it("answers an SSE error event with a 502 and its payload", async () => {
    const calls: RecordedCall[] = [];
    const resp = await proxyRequest(
      makeClientReq({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, "anthropic"),
      "anthropic",
      { config: { ...TEST_CONFIG }, auth: makeAuth(), fetchImpl: sseFetch(calls, SSE_ERROR) },
    );
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toContain("overloaded_error");
  });
});

describe("proxyRequest — batch-as-stream (OpenAI translated path)", () => {
  it("collects the anthropic SSE and answers with the OpenAI JSON", async () => {
    const calls: RecordedCall[] = [];
    const resp = await proxyRequest(
      makeClientReq({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }, "openai"),
      "openai",
      { config: { ...TEST_CONFIG }, auth: makeAuth(), fetchImpl: sseFetch(calls) },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { object: string; choices: Array<{ message: { content: string } }> };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("streamed reply");
    expect(JSON.parse(calls[0].body).stream).toBe(true);
  });
});
