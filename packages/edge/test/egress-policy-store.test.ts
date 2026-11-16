import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, PolicyStore } from "../src/egress/policy-store.js";

describe("PolicyStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cna-policy-store-"));
    path = join(dir, "nested", "policy.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns DEFAULT_POLICY for a missing file and does not create it", async () => {
    const store = await PolicyStore.load(path);
    expect(store.get()).toEqual(DEFAULT_POLICY);
    expect(store.get()).toEqual({ mode: "ask", allow: [] });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists addAllow, canonicalizes and deduplicates", async () => {
    const store = await PolicyStore.load(path);
    await store.addAllow("GitHub.com.");
    await store.addAllow("github.com");
    await store.addAllow("*.Example.com:8443");

    const reloaded = await PolicyStore.load(path);
    expect(reloaded.get().allow).toEqual(["github.com", "*.example.com:8443"]);
    expect(reloaded.entries()).toEqual([
      { host: "github.com", wildcard: false },
      { host: "example.com", wildcard: true, port: 8443 },
    ]);
  });

  it("rejects an invalid entry in addAllow without changing the file", async () => {
    const store = await PolicyStore.load(path);
    await expect(store.addAllow("https://x.com")).rejects.toThrow(/invalid allowlist entry/);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.get().allow).toEqual([]);
  });

  it("persists setMode", async () => {
    const store = await PolicyStore.load(path);
    await store.setMode("audit");
    expect(store.get().mode).toBe("audit");

    const reloaded = await PolicyStore.load(path);
    expect(reloaded.get().mode).toBe("audit");
  });

  it("keeps both entries when addAllow runs concurrently", async () => {
    const store = await PolicyStore.load(path);
    await Promise.all([store.addAllow("a.example.org"), store.addAllow("b.example.org")]);

    const reloaded = await PolicyStore.load(path);
    expect(reloaded.get().allow).toHaveLength(2);
    expect(reloaded.get().allow).toEqual(
      expect.arrayContaining(["a.example.org", "b.example.org"]),
    );
  });

  it("keeps the memory state when a write fails", async () => {
    const store = await PolicyStore.load(path);
    await store.addAllow("github.com");
    // A directory at the temporary path makes the write fail.
    await mkdir(`${path}.tmp`);
    await expect(store.addAllow("pypi.org")).rejects.toThrow();
    expect(store.get().allow).toEqual(["github.com"]);

    const reloaded = await PolicyStore.load(path);
    expect(reloaded.get().allow).toEqual(["github.com"]);
  });

  it("writes the file with mode 0o600 and leaves no temporary file", async () => {
    const store = await PolicyStore.load(path);
    await store.addAllow("github.com");
    await store.setMode("allowlist");

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "nested"))).toEqual(["policy.json"]);
  });

  it("writes JSON with two spaces and a trailing newline", async () => {
    const store = await PolicyStore.load(path);
    await store.addAllow("github.com");
    expect(await readFile(path, "utf8")).toBe(
      '{\n  "mode": "ask",\n  "allow": [\n    "github.com"\n  ]\n}\n',
    );
  });

  it("canonicalizes and deduplicates entries read from the file", async () => {
    await mkdirAndWrite(path, {
      mode: "allowlist",
      allow: ["GitHub.com.", "github.com", "*.Example.com:443"],
    });
    const store = await PolicyStore.load(path);
    expect(store.get()).toEqual({
      mode: "allowlist",
      allow: ["github.com", "*.example.com:443"],
    });
  });

  it("rejects invalid JSON", async () => {
    await mkdirAndWrite(path, "{ not json");
    await expect(PolicyStore.load(path)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an unknown mode", async () => {
    await mkdirAndWrite(path, { mode: "open", allow: [] });
    await expect(PolicyStore.load(path)).rejects.toThrow(/unknown mode/);
  });

  it("rejects a non-array allow", async () => {
    await mkdirAndWrite(path, { mode: "ask", allow: "github.com" });
    await expect(PolicyStore.load(path)).rejects.toThrow(/"allow"/);
  });

  it("rejects an invalid entry", async () => {
    await mkdirAndWrite(path, { mode: "ask", allow: ["github.com", "x.com/path"] });
    await expect(PolicyStore.load(path)).rejects.toThrow(/invalid allowlist entry/);
  });

  it("rejects a JSON value that is not an object", async () => {
    await mkdirAndWrite(path, ["ask"]);
    await expect(PolicyStore.load(path)).rejects.toThrow(/JSON object/);
  });

  it("does not share DEFAULT_POLICY between instances", async () => {
    const store = await PolicyStore.load(path);
    const copy = store.get();
    copy.allow.push("github.com");
    copy.mode = "audit";
    expect(store.get()).toEqual({ mode: "ask", allow: [] });
    expect(DEFAULT_POLICY).toEqual({ mode: "ask", allow: [] });
  });
});

async function mkdirAndWrite(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
