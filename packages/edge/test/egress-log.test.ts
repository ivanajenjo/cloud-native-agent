import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkLogEntry } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileNetworkLog } from "../src/egress/log.js";

function entry(index: number): NetworkLogEntry {
  return {
    ts: new Date(Date.UTC(2026, 10, 16, 12, 0, index)).toISOString(),
    method: "CONNECT",
    host: `host${index}.example.com`,
    port: 443,
    decision: "allow",
    reason: "audit",
    bytesOut: index * 10,
    bytesIn: index * 20,
    durationMs: index,
  };
}

describe("createFileNetworkLog", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cna-egress-log-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("creates missing parent directories and writes concurrent entries in call order", async () => {
    const file = join(root, "a", "b", "c", "network.jsonl");
    const log = createFileNetworkLog(file);
    const entries = Array.from({ length: 20 }, (_, i) => entry(i));

    await Promise.all(entries.map((e) => log.append(e)));
    await log.close();

    const lines = (await readFile(file, "utf8")).split("\n");
    expect(lines.at(-1)).toBe("");
    const parsed = lines.slice(0, -1).map((line) => JSON.parse(line) as NetworkLogEntry);
    expect(parsed).toEqual(entries);
  });

  it("creates the file with mode 0o600", async () => {
    const file = join(root, "network.jsonl");
    const log = createFileNetworkLog(file);
    await log.append(entry(1));
    await log.close();

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("has written every entry once close() resolves", async () => {
    const file = join(root, "network.jsonl");
    const log = createFileNetworkLog(file);
    void log.append(entry(1));
    void log.append(entry(2));
    await log.close();

    const content = await readFile(file, "utf8");
    expect(content).toBe(`${JSON.stringify(entry(1))}\n${JSON.stringify(entry(2))}\n`);
  });

  it("does not throw when the path is not writable", async () => {
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "x");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createFileNetworkLog(join(blocker, "network.jsonl"));

    await expect(log.append(entry(1))).resolves.toBeUndefined();
    await expect(log.close()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
