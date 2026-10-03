/**
 * Tests for the request log row (`printRow`): TTFB and total durations must
 * render in human-readable units (ms below 1s, seconds below 1m, `NmNs`
 * above) instead of raw milliseconds, matching the compact log format.
 */
import { describe, it, expect } from "bun:test";
import { printRow, type RequestMeta } from "./handler.js";
import { captureConsoleLog } from "./handler-debug.test.js";
import type { Format } from "../translator/types.js";

/** Capture the console.log output of one `printRow` call. */
async function captureRow(
  meta: RequestMeta,
  started: number,
  headersAt: number,
  streamEndAt: number,
): Promise<string> {
  const lines = await captureConsoleLog(async () => {
    printRow("#041", "anthropic" as Format, meta, 200, started, headersAt, 2234, 37.2, streamEndAt);
  });
  return lines.join("\n");
}

describe("request log row durations", () => {
  it("keeps raw ms below one second", async () => {
    const out = await captureRow({ model: "glm-5.3-flash", stream: true }, 0, 850, 900);
    expect(out).toContain("850ms");
  });

  it("renders durations above one second in readable units", async () => {
    const out = await captureRow({ model: "glm-5.3-flash", stream: true }, 0, 13_036, 60_054);
    expect(out).toContain("| #041 |");
    expect(out).toContain("13.0s");
    expect(out).toContain("1m0s");
    expect(out).not.toContain("13036ms");
    expect(out).not.toContain("60054ms");
  });

  it("renders a batch row with no stream end as -", async () => {
    const out = await captureRow({ model: "glm-4.6", stream: false }, 0, 850, 0);
    expect(out).toContain("850ms");
    expect(out).toContain("   - |");
  });
});
