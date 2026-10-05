/**
 * Reassemble an Anthropic SSE stream into the single non-streaming `messages`
 * JSON it represents.
 *
 * Batch client requests are sent upstream as `stream: true` (the
 * `batchAsStream` config): the upstream gateway kills requests whose
 * time-to-first-byte sits silent past ~180s — unreachable for streaming,
 * where bytes flow immediately, but routine for long non-streaming
 * generations (observed live 2026-10-05 as connection deaths at exactly
 * 2m59s with no status line at all). This module rebuilds the batch
 * response the client expects from the stream.
 */
import type { AnthropicContentBlock, AnthropicMessagesResponse } from "../translator/types.js";
import { inflateStreamForCodings } from "./inflate.js";

/** Thrown when the stream cannot be reassembled into a message. */
export class UpstreamStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamStreamError";
  }
}

/**
 * Collect the SSE stream into one Anthropic message. `contentCodings` is the
 * response's `content-encoding` list — the proxy fetches upstream with
 * `decompress: false`, so a compressed stream arrives raw and must be
 * inflated here before frame parsing.
 */
export async function collectAnthropicMessage(
  body: ReadableStream<Uint8Array>,
  contentCodings: string[] = [],
): Promise<AnthropicMessagesResponse> {
  let stream = body;
  if (contentCodings.length > 0) {
    const inflated = inflateStreamForCodings(body, contentCodings);
    if (!inflated) {
      throw new UpstreamStreamError(`cannot inflate the upstream stream (content-encoding: ${contentCodings.join(", ")})`);
    }
    stream = inflated;
  }
  const wire = await new Response(stream).text();
  return collectFromWire(wire);
}

/** Assemble from already-decoded SSE text (exposed for tests). */
export function collectFromWire(wire: string): AnthropicMessagesResponse {
  let message: AnthropicMessagesResponse | null = null;
  const blocks: (Record<string, unknown> | undefined)[] = [];
  let sawMessageStop = false;

  for (const payload of dataPayloads(wire)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // tolerate a malformed keepalive; truncation is caught below
    }

    switch (event.type) {
      case "message_start": {
        message = JSON.parse(JSON.stringify(event.message)) as AnthropicMessagesResponse;
        break;
      }
      case "content_block_start": {
        blocks[indexOf(event)] = JSON.parse(JSON.stringify(event.content_block)) as Record<string, unknown>;
        break;
      }
      case "content_block_delta": {
        applyDelta(blocks[indexOf(event)], event.delta as Record<string, unknown> | undefined);
        break;
      }
      case "message_delta": {
        if (!message) break;
        const delta = event.delta as { stop_reason?: string | null; stop_sequence?: string | null } | undefined;
        if (delta?.stop_reason !== undefined) message.stop_reason = delta.stop_reason as AnthropicMessagesResponse["stop_reason"];
        if (delta?.stop_sequence !== undefined) message.stop_sequence = delta.stop_sequence;
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) message.usage.output_tokens = usage.output_tokens;
        break;
      }
      case "message_stop": {
        sawMessageStop = true;
        break;
      }
      case "error": {
        const upstreamError = event.error as { type?: string; message?: string } | undefined;
        throw new UpstreamStreamError(`upstream stream error: ${upstreamError?.type ?? "unknown"}: ${upstreamError?.message ?? ""}`);
      }
      default:
        break; // ping and unknown event types carry no assembly state
    }
  }

  if (!message) throw new UpstreamStreamError("upstream stream ended without a message_start");
  if (!sawMessageStop) throw new UpstreamStreamError("upstream stream ended without message_stop (truncated)");

  const dense: AnthropicContentBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] ?? { type: "text", text: "" };
    finalizeBlock(block);
    dense.push(block as unknown as AnthropicContentBlock);
  }
  message.content = dense;
  return message;
}

function indexOf(event: Record<string, unknown>): number {
  return typeof event.index === "number" ? event.index : 0;
}

function applyDelta(block: Record<string, unknown> | undefined, delta: Record<string, unknown> | undefined): void {
  if (!block || !delta) return;
  switch (delta.type) {
    case "text_delta":
      block.text = String(block.text ?? "") + String(delta.text ?? "");
      break;
    case "input_json_delta":
      block.partial_json = String(block.partial_json ?? "") + String(delta.partial_json ?? "");
      break;
    case "thinking_delta":
      block.thinking = String(block.thinking ?? "") + String(delta.thinking ?? "");
      break;
    case "signature_delta":
      block.signature = String(block.signature ?? "") + String(delta.signature ?? "");
      break;
    default:
      break; // redacted_thinking and unknown deltas carry no incremental body
  }
}

/** tool_use blocks arrive as accumulated `partial_json` — parse it into `input`. */
function finalizeBlock(block: Record<string, unknown>): void {
  if (typeof block.partial_json !== "string") return;
  const raw = block.partial_json;
  delete block.partial_json;
  try {
    block.input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new UpstreamStreamError(`tool_use input failed to parse from the stream: ${(err as Error).message}`);
  }
}

/** Yield every SSE frame's joined `data:` payload, tolerating CRLF and comments. */
function* dataPayloads(wire: string): Generator<string> {
  for (const frame of wire.split(/\r?\n\r?\n/)) {
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) yield data.join("\n");
  }
}
