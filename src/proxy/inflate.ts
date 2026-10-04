/**
 * Shared content-coding helpers and bounded inflation (audit CL-17).
 *
 * `inflateWithCap` used to exist as byte-for-byte copies in proxy/handler.ts
 * and async/handler.ts, and the coding map used to live in
 * ordered-transport.ts — fixes to one never reached the other. Callers keep
 * their own limits and error contracts; this module only maps codings, judges
 * client acceptance and performs the (bounded / chained) inflation.
 */

/**
 * HTTP content-coding → `DecompressionStream` format token.
 *
 * The ultra gateway's CDN applies brotli to SSE streams whenever the request
 * advertises `br` (observed 2026-09-18 on coding-plan traffic rerouted via
 * proxyEndpoint.mapping; the direct provider endpoints never compress SSE).
 * Format ids differ from HTTP tokens (`br` → `"brotli"`), and support is
 * runtime-dependent (Node's DecompressionStream accepts only
 * gzip/deflate/deflate-raw; Bun adds brotli/zstd), so every use is
 * capability-checked by CONSTRUCTING the stream, never by version sniffing.
 */
const CODING_FORMATS: Readonly<Record<string, Bun.CompressionFormat>> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
};

/** Every wire coding token this module can map (capability still checked per use). */
export const KNOWN_CODING_TOKENS: readonly string[] = Object.keys(CODING_FORMATS);

// The DOM-lib `DecompressionStream` constructor type omits Bun's "brotli"/
// "zstd" formats even though the runtime accepts them — route construction
// through a Bun-typed alias so the wider format union stays type-safe.
type InflateConstructor = new (format: Bun.CompressionFormat) => DecompressionStream;
const makeInflateStream: InflateConstructor = DecompressionStream as unknown as InflateConstructor;

/** A DecompressionStream for a known-good format token (from inflateFormatFor). */
export function newInflateStream(format: Bun.CompressionFormat): ReadableWritablePair<Uint8Array, Uint8Array> {
  return new makeInflateStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

/**
 * Capability-checked DecompressionStream format for a wire content-coding
 * token, or null when this runtime cannot inflate it (decided by constructing
 * the stream — on Node `br`/`zstd` throw at construction and return null).
 */
export function inflateFormatFor(coding: string): Bun.CompressionFormat | null {
  const format = CODING_FORMATS[coding.trim().toLowerCase()];
  if (format === undefined) return null;
  try {
    new makeInflateStream(format);
    return format;
  } catch {
    return null;
  }
}

/**
 * True when an accept-encoding header admits `coding` (`x-gzip` is judged as
 * gzip — clients that accept gzip decode x-gzip; `q=0` excludes; a bare `*`
 * includes). A missing header admits nothing, matching the old gzip-only
 * regex semantics.
 */
export function clientAcceptsCoding(acceptEncoding: string | null | undefined, coding: string): boolean {
  if (!acceptEncoding) return false;
  const normalized = coding.trim().toLowerCase();
  const target = normalized === "x-gzip" ? "gzip" : normalized;
  for (const entry of acceptEncoding.split(",")) {
    const [name, ...params] = entry.split(";");
    const token = name.trim().toLowerCase();
    if (token !== target && token !== "*") continue;
    const qZero = params.some((p) => {
      const eq = p.indexOf("=");
      return eq >= 0 && p.slice(0, eq).trim().toLowerCase() === "q" && Number.parseFloat(p.slice(eq + 1).trim()) === 0;
    });
    if (!qZero) return true;
  }
  return false;
}

/**
 * Inflate `stream` through every coding in a content-encoding list. The list
 * names codings outermost LAST (RFC 9110 §8.4.1), so decoding runs in
 * reverse. Returns null when any coding is not runtime-inflatable — callers
 * must then forward raw with truthful headers instead of guessing.
 */
export function inflateStreamForCodings(stream: ReadableStream<Uint8Array>, codings: string[]): ReadableStream<Uint8Array> | null {
  let current = stream;
  for (let i = codings.length - 1; i >= 0; i--) {
    const format = inflateFormatFor(codings[i]);
    if (format === null) return null;
    current = current.pipeThrough(newInflateStream(format));
  }
  return current;
}

export type InflateResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" }
  | { ok: false; reason: "corrupt"; detail: string };

/**
 * Inflate `bytes` with the given format, reading at most `limitBytes` of
 * DECOMPRESSED output. The stream is cancelled and the reader lock released
 * as soon as the limit trips (a small wire payload cannot expand into
 * unbounded memory), and on any decode error.
 *
 * `too_large` carries no detail by design — callers embed their own limit in
 * the user-facing message.
 */
export async function inflateWithCap(bytes: Uint8Array, limitBytes: number, format: Bun.CompressionFormat = "gzip"): Promise<InflateResult> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(newInflateStream(format)).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      parts.push(value);
    }
    return { ok: true, bytes: Buffer.concat(parts) };
  } catch (err) {
    return { ok: false, reason: "corrupt", detail: (err as Error).message };
  } finally {
    reader.releaseLock?.();
  }
}
