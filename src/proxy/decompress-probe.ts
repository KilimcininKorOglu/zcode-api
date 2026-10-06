/**
 * Measure what THIS runtime's fetch actually does with compressed responses.
 *
 * stripAutoDecodedEncoding must know which codings fetch inflates
 * transparently: undici (Node's fetch) decodes gzip/
 * deflate/br while keeping the stale `content-encoding` header, while Bun
 * honors its `decompress: false` extension and returns raw bytes. A hardcoded
 * runtime sniff (`typeof Bun === "undefined"`) goes stale the day a runtime
 * changes — undici could start decoding zstd — so the behavior is MEASURED
 * once at first use: a one-shot loopback server serves pre-compressed
 * payloads, one fetch per coding, and a body matching the PLAINTEXT (not the
 * wire bytes) proves auto-decode.
 *
 * A coding the runtime cannot even COMPRESS (CompressionStream throws) is
 * skipped — it could not auto-decode it either. The caller falls back to the
 * legacy assumption set (with a warning) only when the probe itself errors.
 */
import { createServer, type Server } from "node:http";

const PAYLOAD = "zcode-decompress-probe:0123456789:abcdefghijklmnop";

/** wire coding → CompressionStream format (mirrors inflate.ts's inflate map). */
const PROBE_CODEINGS: ReadonlyArray<readonly [string, string]> = [
  ["gzip", "gzip"],
  ["deflate", "deflate"],
  ["br", "brotli"],
  ["zstd", "zstd"],
];

// Same alias trick as inflate.ts: the DOM type omits Bun's brotli/zstd formats.
const makeCompressStream = CompressionStream as unknown as new (format: Bun.CompressionFormat) => CompressionStream;

async function compressPayload(format: string): Promise<Uint8Array | null> {
  try {
    const compressor = new makeCompressStream(format as Bun.CompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(PAYLOAD));
        controller.close();
      },
    });
    const parts: Uint8Array[] = [];
    for await (const chunk of source.pipeThrough(compressor) as unknown as AsyncIterable<Uint8Array>) {
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } catch {
    return null;
  }
}

function listenOnce(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("probe server has no port"));
    });
  });
}

/**
 * Runs the loopback probe and returns the codings this runtime's fetch
 * auto-decodes even when asked not to. Empty set = the fetch honors
 * `decompress: false` (Bun behavior). Never throws except on unexpected
 * internal failures — the timeout guard converts a wedged loopback into an
 * empty result per coding that was not yet measured.
 */
export async function probeFetchDecompressBehavior(): Promise<ReadonlySet<string>> {
  const probes: { coding: string; wire: Uint8Array }[] = [];
  for (const [coding, format] of PROBE_CODEINGS) {
    const wire = await compressPayload(format);
    if (wire) probes.push({ coding, wire });
  }
  if (probes.length === 0) return new Set();

  const server = createServer((req, res) => {
    const probe = probes.find((p) => req.url === `/${p.coding}`);
    if (!probe) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-encoding": probe.coding });
    res.end(probe.wire);
  });
  const port = await listenOnce(server);
  const autoDecoded = new Set<string>();
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (const { coding } of probes) {
      const resp = await fetch(`${origin}/${coding}`, {
        signal: AbortSignal.timeout(2000),
        decompress: false,
      } as RequestInit);
      const body = new TextDecoder().decode(new Uint8Array(await resp.arrayBuffer()));
      if (body === PAYLOAD) autoDecoded.add(coding);
    }
  } finally {
    server.close();
  }
  return autoDecoded;
}
