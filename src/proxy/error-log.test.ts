/**
 * Tests for the persistent error log: JSONL appends, path resolution order,
 * size rotation and the bun:test guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendErrorLog, errorLogPath, rotateErrorLogIfNeeded, __resetErrorLogForTests } from "./error-log.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "errlog-"));
  process.env.ZCODE_ERROR_LOG = join(dir, "errors.log");
  __resetErrorLogForTests();
});

afterEach(() => {
  delete process.env.ZCODE_ERROR_LOG;
  __resetErrorLogForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("appendErrorLog", () => {
  it("writes self-contained JSONL entries with local-offset timestamps", () => {
    appendErrorLog({ kind: "request_error", reqId: "#001", status: 502 });
    appendErrorLog({ kind: "upstream_gateway_retry", reqId: "#001", status: 504 });
    const lines = readFileSync(errorLogPath(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as { kind: string; reqId: string; status: number; ts: string };
    expect(first.kind).toBe("request_error");
    expect(first.reqId).toBe("#001");
    expect(first.status).toBe(502);
    // Local time WITH the UTC offset (matches the request log rows), not UTC Z.
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("resolves the explicit ZCODE_ERROR_LOG path", () => {
    appendErrorLog({ kind: "request_error", status: 503 });
    expect(errorLogPath()).toBe(join(dir, "errors.log"));
  });

  it("never throws on an unwritable destination and disables itself", () => {
    process.env.ZCODE_ERROR_LOG = join(dir, "no-such-dir", "errors.log");
    __resetErrorLogForTests();
    expect(() => appendErrorLog({ kind: "request_error", status: 502 })).not.toThrow();
    expect(() => appendErrorLog({ kind: "request_error", status: 502 })).not.toThrow();
  });
});

describe("rotateErrorLogIfNeeded", () => {
  it("moves an oversized log aside and lets the next write start fresh", () => {
    const path = join(dir, "errors.log");
    writeFileSync(path, "x".repeat(64));
    rotateErrorLogIfNeeded(path, 32);
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("x".repeat(64));
    appendErrorLog({ kind: "request_error", status: 502 });
    const fresh = JSON.parse(readFileSync(path, "utf-8")) as { kind: string };
    expect(fresh.kind).toBe("request_error");
  });

  it("leaves a small log untouched", () => {
    const path = join(dir, "errors.log");
    writeFileSync(path, "tiny");
    rotateErrorLogIfNeeded(path, 32);
    expect(readFileSync(path, "utf-8")).toBe("tiny");
  });
});
