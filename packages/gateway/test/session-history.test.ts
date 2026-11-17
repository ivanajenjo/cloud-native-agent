import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HistoryRecord, HistoryStore } from "../src/session/history.js";

const SECRET = "secret-repo-xyz";

let dir: string;
let file: string;
let sessionDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-history-"));
  file = join(dir, "state", "history.json");
  sessionDir = join(dir, "sessions");
  await mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Minute `n` of 2026-01-01, so that a larger n is newer. */
function at(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
}

function record(id: string, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id,
    repo: "owner/repo",
    baseBranch: "main",
    branch: "agent/task",
    pr: null,
    mode: "auto",
    model: null,
    createdAt: at(1),
    closedAt: at(2),
    status: "closed",
    stats: null,
    ...overrides,
  };
}

function makeStore(overrides: { limit?: number; logError?: (message: string) => void } = {}) {
  return new HistoryStore({
    file,
    sessionDir,
    logError: vi.fn(),
    ...overrides,
  });
}

async function touchPiSession(id: string, prefix = "2026-01-01T00-00-00"): Promise<string> {
  const path = join(sessionDir, `${prefix}_${id}.jsonl`);
  await writeFile(path, "{}\n");
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("HistoryStore load and persistence", () => {
  it("is empty when the file does not exist", async () => {
    const logError = vi.fn();
    const store = makeStore({ logError });

    await store.load();

    expect(await store.list()).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("keeps the records after a new store loads the file", async () => {
    const first = makeStore();
    const closed = record("abc", { stats: null });
    const running = record("def", {
      createdAt: at(3),
      closedAt: null,
      status: "running",
      branch: null,
      pr: 7,
      model: "p/m",
      stats: {
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: 0.5,
        messages: { user: 1, assistant: 1, toolCalls: 2 },
        context: { tokens: null, window: 100, percent: null },
      },
    });
    await first.upsert(closed);
    await first.upsert(running);

    const second = makeStore();
    await second.load();

    expect(second.get("abc")).toEqual(closed);
    expect(second.get("def")).toEqual(running);
    expect((await second.list()).map(({ resumable: _, ...rest }) => rest)).toEqual([
      running,
      closed,
    ]);
  });

  it("returns a copy from get", async () => {
    const store = makeStore();
    await store.upsert(record("abc"));

    const copy = store.get("abc");
    if (copy === undefined) throw new Error("expected a record");
    copy.model = "changed";

    expect(store.get("abc")?.model).toBeNull();
  });

  it("replaces the record with the same id", async () => {
    const store = makeStore();
    await store.upsert(record("abc", { model: "p/one" }));
    await store.upsert(record("abc", { model: "p/two", createdAt: at(5) }));

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.model).toBe("p/two");
    expect(store.get("abc")?.createdAt).toBe(at(5));
  });

  it("lists the newest first and breaks ties by id", async () => {
    const store = makeStore();
    await store.upsert(record("old", { createdAt: at(1) }));
    await store.upsert(record("tie-b", { createdAt: at(3) }));
    await store.upsert(record("new", { createdAt: at(4) }));
    await store.upsert(record("tie-a", { createdAt: at(3) }));

    expect((await store.list()).map((entry) => entry.id)).toEqual(["new", "tie-a", "tie-b", "old"]);
  });

  it("writes the file with mode 0o600 and creates its directory", async () => {
    const store = makeStore();

    await store.upsert(record("abc"));

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
    const body = JSON.parse(await readFile(file, "utf8")) as { version: number };
    expect(body.version).toBe(1);
    expect(await exists(`${file}.tmp`)).toBe(false);
  });

  it("persists every upsert made without await, in call order", async () => {
    const store = makeStore();

    const writes = [
      store.upsert(record("a", { model: "p/first", createdAt: at(1) })),
      store.upsert(record("b", { createdAt: at(2) })),
      store.upsert(record("a", { model: "p/second", createdAt: at(1) })),
      store.upsert(record("c", { createdAt: at(3) })),
    ];
    await Promise.all(writes);

    const reloaded = makeStore();
    await reloaded.load();
    expect(reloaded.get("a")?.model).toBe("p/second");
    expect((await reloaded.list()).map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("rejects only the failed upsert and keeps working afterwards", async () => {
    const store = makeStore();
    // A directory where the temporary file should go makes the write fail.
    await mkdir(`${file}.tmp`, { recursive: true });

    await expect(store.upsert(record("abc"))).rejects.toThrow();
    expect(store.get("abc")).toBeUndefined();

    await rm(`${file}.tmp`, { recursive: true });
    await store.upsert(record("def"));
    expect(store.get("def")).toBeDefined();
  });

  it("rejects a record whose shape does not match the format", async () => {
    const store = makeStore();
    const broken = { ...record("abc"), mode: "yolo" } as unknown as HistoryRecord;

    await expect(store.upsert(broken)).rejects.toThrow("invalid history record");
    expect(await exists(file)).toBe(false);
  });

  it("drops records with an invalid id when loading", async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessions: [record("good"), record("../bad"), record("a/b")],
      }),
    );

    const store = makeStore();
    await store.load();

    expect((await store.list()).map((entry) => entry.id)).toEqual(["good"]);
  });
});

describe("HistoryStore resumable", () => {
  it("is true only for a closed session with a branch and a Pi file", async () => {
    const store = makeStore();
    await touchPiSession("ok");
    await touchPiSession("open");
    await touchPiSession("nobranch");
    await store.upsert(record("ok"));
    await store.upsert(record("open", { closedAt: null, status: "ready" }));
    await store.upsert(record("nobranch", { branch: null }));
    await store.upsert(record("nofile"));

    const resumable = Object.fromEntries(
      (await store.list()).map((entry) => [entry.id, entry.resumable]),
    );

    expect(resumable).toEqual({ ok: true, open: false, nobranch: false, nofile: false });
  });

  it("is false when the session is not closed even with a Pi file", async () => {
    const store = makeStore();
    await touchPiSession("open");
    await store.upsert(record("open", { closedAt: null, status: "running" }));

    expect((await store.list())[0]?.resumable).toBe(false);
  });

  it("is false when the branch is null even with a Pi file", async () => {
    const store = makeStore();
    await touchPiSession("nobranch");
    await store.upsert(record("nobranch", { branch: null }));

    expect((await store.list())[0]?.resumable).toBe(false);
  });

  it("is false when there is no Pi file for the id", async () => {
    const store = makeStore();
    await touchPiSession("other");
    await store.upsert(record("nofile"));

    expect(await store.hasPiSession("nofile")).toBe(false);
    expect((await store.list())[0]?.resumable).toBe(false);
  });
});

describe("HistoryStore retention", () => {
  it("drops the oldest record and its Pi file, but not the file of an id that ends with it", async () => {
    const store = makeStore({ limit: 3 });
    const abcFile = await touchPiSession("abc", "t1");
    const xAbcFile = await touchPiSession("x-abc", "t2");
    const dFile = await touchPiSession("d", "t3");
    await store.upsert(record("abc", { createdAt: at(1) }));
    await store.upsert(record("x-abc", { createdAt: at(2) }));
    await store.upsert(record("d", { createdAt: at(3) }));

    await store.upsert(record("e", { createdAt: at(4) }));

    expect((await store.list()).map((entry) => entry.id)).toEqual(["e", "d", "x-abc"]);
    expect(store.get("abc")).toBeUndefined();
    expect(await exists(abcFile)).toBe(false);
    expect(await exists(xAbcFile)).toBe(true);
    expect(await exists(dFile)).toBe(true);
  });

  it("does not drop the record just upserted, even when it is the oldest", async () => {
    const store = makeStore({ limit: 2 });
    const newFile = await touchPiSession("new", "t1");
    const midFile = await touchPiSession("mid", "t2");
    const oldFile = await touchPiSession("old", "t3");
    await store.upsert(record("new", { createdAt: at(3) }));
    await store.upsert(record("mid", { createdAt: at(2) }));

    await store.upsert(record("old", { createdAt: at(1) }));

    expect((await store.list()).map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(await exists(newFile)).toBe(true);
    expect(await exists(midFile)).toBe(false);
    expect(await exists(oldFile)).toBe(true);
  });

  it("uses HISTORY_LIMIT when no limit is given", async () => {
    const store = makeStore();
    for (let i = 0; i < 51; i++) {
      await store.upsert(record(`s${i}`, { createdAt: at(i) }));
    }

    const ids = (await store.list()).map((entry) => entry.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("s0");
  });

  it("never deletes a symlink nor follows it", async () => {
    const outside = join(dir, "outside.jsonl");
    await writeFile(outside, "{}\n");
    await symlink(outside, join(sessionDir, "t1_old.jsonl"));
    const store = makeStore({ limit: 1 });
    await store.upsert(record("old", { createdAt: at(1) }));

    expect(await store.hasPiSession("old")).toBe(false);
    await store.upsert(record("new", { createdAt: at(2) }));

    expect(await exists(outside)).toBe(true);
    expect(await exists(join(sessionDir, "t1_old.jsonl"))).toBe(true);
  });

  it("does not look into subdirectories", async () => {
    await mkdir(join(sessionDir, "nested"));
    await writeFile(join(sessionDir, "nested", "t_nested-two.jsonl"), "{}\n");
    const store = makeStore();

    expect(await store.hasPiSession("nested-two")).toBe(false);
  });
});

describe("HistoryStore session ids", () => {
  it.each(["../x", "a/b", "", "a_b", "-x", "x".repeat(129)])(
    "rejects the invalid id %j without touching files",
    async (id) => {
      const keep = await touchPiSession("ok", "t1");
      const store = makeStore();

      expect(await store.hasPiSession(id)).toBe(false);
      await expect(store.upsert(record(id))).rejects.toThrow("invalid session id");
      expect(await exists(keep)).toBe(true);
      expect(await exists(file)).toBe(false);
    },
  );

  it("accepts an id of 128 characters", async () => {
    const id = `a${"b".repeat(127)}`;
    await touchPiSession(id, "t1");
    const store = makeStore();

    expect(await store.hasPiSession(id)).toBe(true);
  });
});

describe("HistoryStore corrupt file", () => {
  it("starts empty, moves the file to .corrupt and logs without its contents", async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `{"version": 1, "sessions": [ ${SECRET}`);
    const logError = vi.fn();
    const store = makeStore({ logError });

    await store.load();

    expect(await store.list()).toEqual([]);
    expect(await readFile(`${file}.corrupt`, "utf8")).toContain(SECRET);
    expect(await exists(file)).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls.join("\n")).not.toContain(SECRET);
  });

  it("treats a wrong shape as corrupt", async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, sessions: [{ repo: SECRET }] }));
    const logError = vi.fn();
    const store = makeStore({ logError });

    await store.load();

    expect(await store.list()).toEqual([]);
    expect(await exists(`${file}.corrupt`)).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls.join("\n")).not.toContain(SECRET);
  });

  it("writes a new file after a corrupt one was moved", async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "not json");
    const store = makeStore({ logError: vi.fn() });

    await store.upsert(record("abc"));

    const reloaded = makeStore();
    await reloaded.load();
    expect(reloaded.get("abc")).toBeDefined();
  });
});
