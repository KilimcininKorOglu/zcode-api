/**
 * Tests for the Anthropic SSE collector: full-message assembly (text,
 * thinking, tool_use with accumulated partial_json), usage/stop_reason from
 * message_delta, error events, truncation detection and content-encoding
 * inflation.
 */
import { describe, it, expect } from "bun:test";
import { collectAnthropicMessage, collectFromWire, UpstreamStreamError } from "./sse-collector.js";
import { formatAnthropicSSE } from "../translator/sse-translator.js";

function wireOf(...events: Record<string, unknown>[]): string {
  return events.map((event) => formatAnthropicSSE(String(event.type), event)).join("");
}

function messageStart(): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_c1",
      type: "message",
      role: "assistant",
      model: "glm-5.3-flash",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 0 },
    },
  };
}

describe("collectFromWire — text message", () => {
  it("assembles text deltas into the final batch message", () => {
    const message = collectFromWire(wireOf(
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Mer" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "haba" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ));
    expect(message.id).toBe("msg_c1");
    expect(message.content).toEqual([{ type: "text", text: "Merhaba" }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  it("keeps multi-block order across indexes", () => {
    const message = collectFromWire(wireOf(
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "dus" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "cevap" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ));
    expect(message.content[0]).toMatchObject({ type: "thinking", thinking: "dus" });
    expect(message.content[1]).toMatchObject({ type: "text", text: "cevap" });
  });
});

describe("collectFromWire — tool_use", () => {
  it("parses the accumulated partial_json into tool_use input", () => {
    const message = collectFromWire(wireOf(
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "fs__read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'th": "a.txt"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ));
    expect(message.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "fs__read", input: { path: "a.txt" } });
    expect(message.stop_reason).toBe("tool_use");
  });

  it("throws a descriptive error when the tool json is broken", () => {
    const wire = wireOf(
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c", name: "t", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{oops" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    );
    expect(() => collectFromWire(wire)).toThrow(UpstreamStreamError);
  });
});

describe("collectFromWire — failures", () => {
  it("surfaces an SSE error event with its payload", () => {
    const wire = wireOf(
      messageStart(),
      { type: "error", error: { type: "overloaded_error", message: "upstream overloaded" } },
    );
    expect(() => collectFromWire(wire)).toThrow(/overloaded_error: upstream overloaded/);
  });

  it("throws on a truncated stream without message_stop", () => {
    const wire = wireOf(
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    );
    expect(() => collectFromWire(wire)).toThrow(/truncated/);
  });

  it("throws when no message ever started", () => {
    expect(() => collectFromWire("event: ping\ndata: {\"type\":\"ping\"}\n\n")).toThrow(/message_start/);
  });
});

describe("collectAnthropicMessage", () => {
  it("inflates the compressed stream before parsing", async () => {
    const wire = wireOf(messageStart(), { type: "message_stop" });
    const compressor = new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const source = new Response(new TextEncoder().encode(wire)).body!.pipeThrough(compressor);
    const message = await collectAnthropicMessage(source, ["gzip"]);
    expect(message.id).toBe("msg_c1");
  });

  it("passes an uncompressed stream straight through", async () => {
    const wire = wireOf(messageStart(), { type: "message_stop" });
    const message = await collectAnthropicMessage(new Response(wire).body!);
    expect(message.id).toBe("msg_c1");
  });
});
