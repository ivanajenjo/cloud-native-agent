import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToolLog,
  MAX_ARGS_CHARS,
  MAX_PENDING,
  MAX_RESULT_CHARS,
  type ToolLog,
  type ToolLogEntry,
} from "../src/logs/tool-log.js";
import { createRedactor } from "../src/redact.js";

const SECRET = "sk-secret-123456";
const NOW = new Date("2026-03-04T05:06:07.000Z");

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tool-log-"));
  filePath = join(dir, "logs", "tools.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeLog(overrides: Partial<Parameters<typeof createToolLog>[0]> = {}): ToolLog {
  return createToolLog({
    filePath,
    redactor: createRedactor([]),
    now: () => NOW,
    logError: vi.fn(),
    ...overrides,
  });
}

async function readEntries(): Promise<ToolLogEntry[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ToolLogEntry);
}

describe("createToolLog entries", () => {
  it("writes one line with every field from start and end", async () => {
    const log = makeLog();

    log.start("s1", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    log.end("s1", {
      toolCallId: "c1",
      toolName: "bash",
      result: {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      isError: false,
      durationMs: 42,
    });
    await log.close();

    const raw = await readFile(filePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n")).toHaveLength(2);
    expect(await readEntries()).toEqual([
      {
        ts: "2026-03-04T05:06:07.000Z",
        sessionId: "s1",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
        isError: false,
        durationMs: 42,
        result: "a\nb",
      },
    ]);
  });

  it("omits durationMs when it is not a number", async () => {
    const log = makeLog();

    log.end("s1", { toolCallId: "c1", toolName: "bash", result: {}, isError: true });
    await log.close();

    const [entry] = await readEntries();
    expect(entry).not.toHaveProperty("durationMs");
    expect(entry?.isError).toBe(true);
  });

  it("writes args null when end has no matching start", async () => {
    const log = makeLog();

    log.end("s1", { toolCallId: "orphan", toolName: "read", result: {}, isError: false });
    await log.close();

    const [entry] = await readEntries();
    expect(entry?.args).toBeNull();
    expect(entry?.toolCallId).toBe("orphan");
  });

  it("does not write anything on start", async () => {
    const log = makeLog();

    log.start("s1", { toolCallId: "c1", toolName: "bash", args: {} });
    await log.close();

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts secrets in args and in result", async () => {
    const log = makeLog({ redactor: createRedactor([SECRET]) });

    log.start("s1", {
      toolCallId: "c1",
      toolName: "bash",
      args: { command: `curl -H "Authorization: ${SECRET}"` },
    });
    log.end("s1", {
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: `echo ${SECRET}` }] },
      isError: false,
    });
    await log.close();

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain(SECRET);
  });

  it("truncates args longer than MAX_ARGS_CHARS into a preview", async () => {
    const log = makeLog();
    const args = { data: "x".repeat(5000) };

    log.start("s1", { toolCallId: "c1", toolName: "write", args });
    log.end("s1", { toolCallId: "c1", toolName: "write", result: {}, isError: false });
    await log.close();

    const [entry] = await readEntries();
    const json = JSON.stringify(args);
    expect(entry?.args).toEqual({
      truncated: true,
      preview: json.slice(0, MAX_ARGS_CHARS),
    });
  });

  it("keeps args that fit as they are", async () => {
    const log = makeLog();

    log.start("s1", { toolCallId: "c1", toolName: "read", args: { path: "a.txt" } });
    log.end("s1", { toolCallId: "c1", toolName: "read", result: {}, isError: false });
    await log.close();

    const [entry] = await readEntries();
    expect(entry?.args).toEqual({ path: "a.txt" });
  });

  it("marks args whose serialization fails as truncated with an empty preview", async () => {
    const log = makeLog();
    const args = { big: BigInt(1) };

    log.start("s1", { toolCallId: "c1", toolName: "bash", args });
    log.end("s1", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });
    await log.close();

    const [entry] = await readEntries();
    expect(entry?.args).toEqual({ truncated: true, preview: "" });
  });

  it("cuts the result at MAX_RESULT_CHARS", async () => {
    const log = makeLog();
    const text = "y".repeat(3000);

    log.end("s1", {
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text }] },
      isError: false,
    });
    await log.close();

    const [entry] = await readEntries();
    expect(entry?.result).toBe("y".repeat(MAX_RESULT_CHARS));
  });

  it("uses an empty result when it is not an object or has no content array", async () => {
    const log = makeLog();

    const results: unknown[] = [42, "text", null, {}, { content: "nope" }];
    results.forEach((result, i) => {
      log.end("s1", { toolCallId: `c${i}`, toolName: "bash", result, isError: false });
    });
    await log.close();

    const entries = await readEntries();
    expect(entries.map((e) => e.result)).toEqual(["", "", "", "", ""]);
  });

  it("ignores non-text parts of the result", async () => {
    const log = makeLog();

    log.end("s1", {
      toolCallId: "c1",
      toolName: "bash",
      result: {
        content: [
          { type: "image", data: "AAAA" },
          { type: "text", text: "only this" },
          { type: "text", text: 7 },
        ],
      },
      isError: false,
    });
    await log.close();

    const [entry] = await readEntries();
    expect(entry?.result).toBe("only this");
  });
});

describe("createToolLog writes", () => {
  it("writes lines in the order of the end calls and close waits for them", async () => {
    const log = makeLog();

    for (let i = 0; i < 20; i++) {
      log.end("s1", { toolCallId: `c${i}`, toolName: "bash", result: {}, isError: false });
    }
    await log.close();

    const entries = await readEntries();
    expect(entries.map((e) => e.toolCallId)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
  });

  it("creates the parent directory and gives the file mode 0o600", async () => {
    const log = makeLog();

    log.end("s1", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });
    await log.close();

    const info = await stat(filePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("reports a failed write through logError and still resolves close", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const logError = vi.fn();
    const log = makeLog({ filePath: join(blocker, "tools.jsonl"), logError });

    log.end("s1", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });

    await expect(log.close()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toMatch(/^tool log: cannot write: /);
  });

  it("keeps writing after a failed write", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const logError = vi.fn();
    const failing = makeLog({ filePath: join(blocker, "tools.jsonl"), logError });
    failing.end("s1", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });
    await failing.close();

    const log = makeLog({ logError });
    log.end("s1", { toolCallId: "c2", toolName: "bash", result: {}, isError: false });
    await log.close();

    expect(logError).toHaveBeenCalledTimes(1);
    const entries = await readEntries();
    expect(entries.map((e) => e.toolCallId)).toEqual(["c2"]);
  });
});

describe("createToolLog pending starts", () => {
  it("drops the oldest pending start when MAX_PENDING is exceeded", async () => {
    const log = makeLog();

    for (let i = 0; i <= MAX_PENDING; i++) {
      log.start("s1", { toolCallId: `c${i}`, toolName: "bash", args: { i } });
    }
    log.end("s1", { toolCallId: "c0", toolName: "bash", result: {}, isError: false });
    log.end("s1", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });
    await log.close();

    const [first, second] = await readEntries();
    expect(first?.args).toBeNull();
    expect(second?.args).toEqual({ i: 1 });
  });
});
