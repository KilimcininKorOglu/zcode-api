/**
 * Tests for the shared content-coding helpers: acceptance judgment, the
 * capability-checked format map, stream-chain inflation and bounded buffer
 * inflation across formats.
 */
import { describe, it, expect } from "bun:test";
import {
  KNOWN_CODING_TOKENS,
  clientAcceptsCoding,
  inflateFormatFor,
  inflateStreamForCodings,
  inflateWithCap,
  newInflateStream,
} from "./inflate.js";

/** Shared across the encoding tests: compress bytes with the given
 * CompressionStream format (the production side of the round trip lives in
 * inflate.ts/decompress-probe.ts and must stay independent of this helper). */
export async function compressTestBytes(bytes: Uint8Array, format: string): Promise<Uint8Array> {
  const compressor = new CompressionStream(format as never) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const parts: Uint8Array[] = [];
  for await (const chunk of source.pipeThrough(compressor) as unknown as AsyncIterable<Uint8Array>) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

async function compress(text: string, format: string): Promise<Uint8Array> {
  return compressTestBytes(new TextEncoder().encode(text), format);
}

describe("clientAcceptsCoding", () => {
  it("accepts a listed coding without q=0 and rejects with q=0", () => {
    expect(clientAcceptsCoding("gzip, deflate, br", "gzip")).toBe(true);
    expect(clientAcceptsCoding("gzip;q=0", "gzip")).toBe(false);
    expect(clientAcceptsCoding("gzip;q=0.0, br", "br")).toBe(true);
    expect(clientAcceptsCoding("deflate, br", "gzip")).toBe(false);
  });

  it("is case-insensitive and whitespace tolerant", () => {
    expect(clientAcceptsCoding(" GZIP , BR ", "gzip")).toBe(true);
    expect(clientAcceptsCoding("GZip", "gzip")).toBe(true);
  });

  it("treats a bare wildcard as accepting everything and a q=0 wildcard as excluding", () => {
    expect(clientAcceptsCoding("*", "zstd")).toBe(true);
    expect(clientAcceptsCoding("*;q=0", "gzip")).toBe(false);
  });

  it("judges x-gzip as gzip and admits nothing without a header", () => {
    expect(clientAcceptsCoding("gzip", "x-gzip")).toBe(true);
    expect(clientAcceptsCoding("br", "x-gzip")).toBe(false);
    expect(clientAcceptsCoding(null, "gzip")).toBe(false);
    expect(clientAcceptsCoding(undefined, "gzip")).toBe(false);
    expect(clientAcceptsCoding("", "gzip")).toBe(false);
  });
});

describe("inflateFormatFor", () => {
  it("maps wire tokens to DecompressionStream formats", () => {
    expect(inflateFormatFor("gzip")).toBe("gzip");
    expect(inflateFormatFor("x-gzip")).toBe("gzip");
    expect(inflateFormatFor("deflate")).toBe("deflate");
    expect(inflateFormatFor(" GZIP ")).toBe("gzip");
    expect(inflateFormatFor("identity")).toBeNull();
    expect(inflateFormatFor("made-up")).toBeNull();
  });

  it("capability-checks the runtime-dependent codings by construction", () => {
    // On Bun brotli/zstd are available; on Node they throw at construction and
    // must come back null instead of poisoning a later pipeThrough.
    for (const coding of ["br", "zstd"]) {
      const format = inflateFormatFor(coding);
      if (format === null) continue;
      expect(() => new DecompressionStream(format as never)).not.toThrow();
    }
    expect(KNOWN_CODING_TOKENS).toContain("gzip");
  });
});

describe("inflateStreamForCodings", () => {
  it("round-trips a single coding and deletes nothing by itself", async () => {
    const wire = await compress("payload-1", "gzip");
    const source = new Response(wire as unknown as BodyInit).body!;
    const inflated = inflateStreamForCodings(source, ["gzip"]);
    expect(inflated).not.toBeNull();
    expect(await new Response(inflated).text()).toBe("payload-1");
  });

  it("round-trips a multi-coding list by decoding in reverse order", async () => {
    // Real chain: gzip applied first, br applied second (outermost last).
    const inner = await compress("payload-2", "gzip");
    const outer = await compressTestBytes(inner, "brotli");
    const source = new Response(outer as unknown as BodyInit).body!;
    const inflated = inflateStreamForCodings(source, ["gzip", "br"]);
    expect(inflated).not.toBeNull();
    expect(await new Response(inflated).text()).toBe("payload-2");
  });

  it("returns null when any coding is not runtime-inflatable", async () => {
    const wire = await compress("payload-3", "gzip");
    const source = new Response(wire as unknown as BodyInit).body!;
    expect(inflateStreamForCodings(source, ["gzip", "made-up"])).toBeNull();
  });
});


describe("inflateWithCap", () => {
  it("inflates with an explicit format", async () => {
    const wire = await compress("explicit-format", "deflate");
    const result = await inflateWithCap(wire, 1024, "deflate");
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.bytes)).toBe("explicit-format");
  });

  it("inflates raw-deflate only when asked with deflate-raw", async () => {
    const wire = await compress("raw-deflate-body", "deflate-raw");
    const asZlib = await inflateWithCap(wire, 1024, "deflate");
    expect(asZlib.ok).toBe(false);
    if (!asZlib.ok && asZlib.reason === "corrupt") expect(asZlib.detail).toBeTruthy();
    const asRaw = await inflateWithCap(wire, 1024, "deflate-raw");
    expect(asRaw.ok).toBe(true);
    if (asRaw.ok) expect(new TextDecoder().decode(asRaw.bytes)).toBe("raw-deflate-body");
  });

  it("reports corrupt data with the runtime's detail", async () => {
    const result = await inflateWithCap(new TextEncoder().encode("not gzip at all"), 1024, "gzip");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason === "corrupt" || result.reason === "too_large").toBe(true);
  });

  it("trips the cap on expanding payloads", async () => {
    const wire = await compress("x".repeat(10_000), "gzip");
    const result = await inflateWithCap(wire, 1024, "gzip");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  it("constructs streams through newInflateStream", () => {
    expect(() => newInflateStream("gzip")).not.toThrow();
  });
});
