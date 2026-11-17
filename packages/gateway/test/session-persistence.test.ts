import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PersistedSession, SessionStateStore } from "../src/session/persistence.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-persistence-"));
  file = join(dir, "state", "session.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sampleState(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    version: 1,
    info: {
      id: "0b6f7c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e",
      status: "ready",
      repo: "octo/hello",
      baseBranch: "main",
      branch: "agent/fix-login",
      model: "openai/gpt-4o",
      thinking: "medium",
      mode: "auto",
      autoPush: false,
      createdAt: "2026-03-04T05:06:07.000Z",
      pr: null,
    },
    todos: [{ id: 1, text: "Read the code", status: "completed" }],
    checkpoints: [
      {
        checkpoint: {
          id: 0,
          commit: "a".repeat(40),
          createdAt: "2026-03-04T05:06:08.000Z",
          reason: "start",
        },
        tree: "b".repeat(40),
        forkIndex: -1,
        todos: [],
      },
      {
        checkpoint: {
          id: 1,
          commit: "c".repeat(40),
          createdAt: "2026-03-04T05:10:00.000Z",
          reason: "run",
        },
        tree: "d".repeat(40),
        forkIndex: 2,
        todos: [{ id: 1, text: "Read the code", status: "in_progress" }],
      },
    ],
    baselineTree: "d".repeat(40),
    ...overrides,
  };
}

function makeStore(): { store: SessionStateStore; logError: ReturnType<typeof vi.fn> } {
  const logError = vi.fn();
  return { store: new SessionStateStore({ file, logError }), logError };
}

describe("SessionStateStore", () => {
  it("load returns null when the file does not exist", async () => {
    const { store, logError } = makeStore();

    await expect(store.load()).resolves.toBeNull();
    expect(logError).not.toHaveBeenCalled();
  });

  it("save then load returns the same state", async () => {
    const { store } = makeStore();
    const state = sampleState();

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it("writes the file with mode 0o600", async () => {
    const { store } = makeStore();

    await store.save(sampleState());

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("creates the directory when it does not exist", async () => {
    const { store } = makeStore();

    await store.save(sampleState());

    expect((await stat(join(dir, "state"))).isDirectory()).toBe(true);
  });

  it("leaves no temporary file after a save", async () => {
    const { store } = makeStore();

    await store.save(sampleState());

    expect(await readdir(join(dir, "state"))).toEqual(["session.json"]);
  });

  it("returns null and logs without the content when the JSON is invalid", async () => {
    const { store, logError } = makeStore();
    const secret = "SECRET-CONTENT-42";
    await writeFileInDir(`{"token": "${secret}"`);

    await expect(store.load()).resolves.toBeNull();

    expect(logError).toHaveBeenCalledTimes(1);
    const message = String(logError.mock.calls[0]?.[0]);
    expect(message).toContain("session.json");
    expect(message).not.toContain(secret);
    await expect(stat(`${file}.corrupt`)).resolves.toBeDefined();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null and moves the file aside when the shape is wrong", async () => {
    const { store, logError } = makeStore();
    const state = sampleState();
    await writeFileInDir(JSON.stringify({ ...state, info: { ...state.info, status: "flying" } }));

    await expect(store.load()).resolves.toBeNull();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).toContain("session.json");
    await expect(stat(`${file}.corrupt`)).resolves.toBeDefined();
  });

  it("returns null when the version is not 1", async () => {
    const { store, logError } = makeStore();
    await writeFileInDir(JSON.stringify({ ...sampleState(), version: 2 }));

    await expect(store.load()).resolves.toBeNull();

    expect(logError).toHaveBeenCalledTimes(1);
    await expect(stat(`${file}.corrupt`)).resolves.toBeDefined();
  });

  it("replaces an older .corrupt file when moving a new one aside", async () => {
    const { store } = makeStore();
    await writeFileInDir("{ broken");
    await writeFile(`${file}.corrupt`, "old");
    await writeFileInDir("{ broken again");

    await store.load();

    expect(await readFile(`${file}.corrupt`, "utf8")).toBe("{ broken again");
  });

  it("ignores unknown extra fields", async () => {
    const { store, logError } = makeStore();
    const state = sampleState();
    await writeFileInDir(
      JSON.stringify({
        ...state,
        futureField: { anything: true },
        info: { ...state.info, futureInfo: 1 },
      }),
    );

    await expect(store.load()).resolves.toEqual(state);
    expect(logError).not.toHaveBeenCalled();
  });

  it("keeps the content of the last of several saves started without await", async () => {
    const { store } = makeStore();
    const first = sampleState();
    const last = sampleState({ todos: [{ id: 1, text: "last", status: "pending" }] });

    const writes = [store.save(first), store.save(sampleState()), store.save(last)];
    await Promise.all(writes);

    await expect(store.load()).resolves.toEqual(last);
  });

  it("rejects a save into an impossible path and keeps the queue working afterwards", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "I am a regular file");
    const store = new SessionStateStore({ file: join(blocker, "session.json") });
    const state = sampleState();

    await expect(store.save(state)).rejects.toThrow();

    await rm(blocker);
    await expect(store.save(state)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(state);
  });

  it("clear does not throw when there is no file", async () => {
    const { store } = makeStore();

    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("clear right after a save without await leaves no file", async () => {
    const { store } = makeStore();

    await Promise.all([store.save(sampleState()), store.clear()]);

    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.load()).resolves.toBeNull();
  });

  it("logs with console.error by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await writeFileInDir("{ broken");
      await new SessionStateStore({ file }).load();

      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  async function writeFileInDir(content: string): Promise<void> {
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(file, content);
  }
});
