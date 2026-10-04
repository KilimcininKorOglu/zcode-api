/**
 * Tests for the runtime decompress-behavior probe: the real loopback
 * measurement (a canary — if a future Bun starts auto-decoding despite
 * `decompress: false`, this FAILS and forces the strip path to be revisited)
 * and the consumer logic in handler.ts that memoizes the result and falls
 * back to the legacy assumption on probe failure.
 */
import { describe, it, expect } from "bun:test";
import { probeFetchDecompressBehavior } from "./decompress-probe.js";
import { stripAutoDecodedEncoding } from "./handler.js";

describe("probeFetchDecompressBehavior", () => {
  it("measures this Bun runtime as honoring decompress:false (no auto-decode)", async () => {
    const autoDecoded = await probeFetchDecompressBehavior();
    // Canary: these hold for Bun 1.x empirically (gzip/deflate since the
    // first release, brotli since the 2026-09-18 SSE investigation). A
    // failure here means the runtime started auto-decoding and the stale
    // header cleanup is now load-bearing on Bun too.
    expect(autoDecoded.has("gzip")).toBe(false);
    expect(autoDecoded.has("deflate")).toBe(false);
    expect(autoDecoded.has("br")).toBe(false);
  });
});

describe("stripAutoDecodedEncoding with a measured set", () => {
  const gzipResp = (): Response => new Response("x", { status: 200, headers: { "content-encoding": "gzip", "content-length": "12" } });

  it("keeps labels when the measurement says nothing was auto-decoded", () => {
    const resp = gzipResp();
    expect(stripAutoDecodedEncoding(resp, new Set())).toBe(resp);
  });

  it("strips only coding lists fully inside the measured set", () => {
    expect(stripAutoDecodedEncoding(gzipResp(), new Set(["gzip", "br"])).headers.get("content-encoding")).toBeNull();

    const multi = new Response("x", { status: 200, headers: { "content-encoding": "gzip, br" } });
    expect(stripAutoDecodedEncoding(multi, new Set(["gzip"])).headers.get("content-encoding")).toBe("gzip, br");
  });

  it("defaults to the legacy assumption set when no measurement is passed", () => {
    expect(stripAutoDecodedEncoding(gzipResp()).headers.get("content-encoding")).toBeNull();
  });
});
