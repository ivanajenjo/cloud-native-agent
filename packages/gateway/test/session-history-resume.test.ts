import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CreateSessionRequest,
  HistoryEntry,
  SessionEvent,
  SessionStats,
  StreamEvent,
} from "@cna/shared";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/events/event-log.js";
import type { PiLaunchSpec } from "../src/pi/launch.js";
import { createRedactor } from "../src/redact.js";
import type { RpcBridgeHandlers, RpcCommandInput, RpcEvent } from "../src/rpc/bridge.js";
import { HistoryStore } from "../src/session/history.js";
import { type PiProcess, SessionManager } from "../src/session/manager.js";
import { SessionStateStore } from "../src/session/persistence.js";
import { SessionError } from "../src/session/service.js";
import { createGitRunner } from "../src/workspace/git.js";

const SECRET = "ghp_supersecret123";

/** Isolated from the machine's git config; identity only for the commits made by the helpers. */
const TEST_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const realGit = createGitRunner(TEST_ENV);

/** Pi's get_session_stats data (docs/rpc-commands.md shape) and what the gateway makes of it. */
const PI_STATS = {
  sessionFile: "/path/to/session.jsonl",
  sessionId: "abc123",
  userMessages: 1,
  assistantMessages: 2,
  toolCalls: 3,
  toolResults: 3,
  totalMessages: 6,
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
  cost: 0.5,
  contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
};

const STATS: SessionStats = {
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
  cost: 0.5,
  messages: { user: 1, assistant: 2, toolCalls: 3 },
  context: { tokens: 100, window: 1000, percent: 10 },
};

let root: string;
let remoteBase: string;
let harnesses: Harness[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-session-history-resume-"));

  // Source repo with one commit on main, then a bare clone as the "remote" octo/hello.
  const source = join(root, "source");
  await mkdir(source);
  await realGit(["init", "--initial-branch=main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await realGit(["add", "README.md"], { cwd: source });
  await realGit(["commit", "-m", "initial"], { cwd: source });

  await mkdir(join(root, "remote", "octo"), { recursive: true });
  await realGit(["clone", "--bare", source, join(root, "remote", "octo", "hello.git")], {
    cwd: root,
  });
  remoteBase = `${pathToFileURL(join(root, "remote")).href}/`;
  harnesses = [];
});

afterEach(async () => {
  for (const harness of harnesses) {
    // A clone still writing into the tmp dir would make the removal below fail.
    if (harness.manager.get()?.status === "cloning") {
      await waitForEvent(
        harness.events,
        (event) => event.type === "status" && event.status !== "cloning",
      ).catch(() => undefined);
    }
    await harness.manager.shutdown();
    // Waits for the state writes still queued, so the removal below does not race them.
    await harness.stateStore.clear().catch(() => undefined);
    await flushHistory(harness).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
});

/** Fake Pi: records the handlers so tests can emit events, answers commands by type. */
type Responder = (command: RpcCommandInput) => unknown;

class FakePi implements PiProcess {
  readonly responders = new Map<string, Responder>();
  readonly send = vi.fn(async (command: RpcCommandInput, _options?: { timeoutMs?: number }) => {
    const responder = this.responders.get(command.type);
    if (responder !== undefined) {
      return responder(command);
    }
    return defaultResponse(command);
  });
  readonly respondUi = vi.fn();
  readonly stop = vi.fn(async () => {
    this.exited = true;
    this.handlers.onExit({ code: null, signal: null, expected: true });
  });
  private exited = false;

  constructor(
    readonly handlers: RpcBridgeHandlers,
    readonly spec: PiLaunchSpec,
  ) {}

  get running(): boolean {
    return !this.exited;
  }

  emit(event: RpcEvent): void {
    this.handlers.onEvent(event);
  }

  ui(request: RpcExtensionUIRequest): void {
    this.handlers.onUiRequest(request);
  }
}

function defaultResponse(command: RpcCommandInput): unknown {
  switch (command.type) {
    case "prompt":
      return { disposition: "started" };
    case "get_messages":
      return { messages: [{ role: "user", content: "hi" }] };
    default:
      return undefined;
  }
}

interface Harness {
  manager: SessionManager;
  events: EventLog;
  stateStore: SessionStateStore;
  /** Undefined when the harness runs without a history (HarnessOptions.withoutHistory). */
  history: HistoryStore | undefined;
  /** Pi's --session-dir: where the conversation files of Pi are. */
  sessionDir: string;
  pis: FakePi[];
  startPi: ReturnType<typeof vi.fn>;
  workspaceDir: string;
  logs: string[];
}

interface HarnessOptions {
  /** Answers of every Pi started by this harness, by command type. */
  responders?: Record<string, Responder>;
  /** When true, startPi throws: Pi does not start. */
  failStart?: boolean;
  /** When true, the manager has no history (ADR-0011 §6 absent). */
  withoutHistory?: boolean;
}

/**
 * A manager over the same data dir as every other harness of this test: a second harness is the
 * gateway after a restart (same workspace dir, same state file, same history file).
 */
function harness(options: HarnessOptions = {}): Harness {
  const events = new EventLog();
  const pis: FakePi[] = [];
  const startPi = vi.fn((spec: PiLaunchSpec, handlers: RpcBridgeHandlers) => {
    if (options.failStart === true) {
      throw new Error("pi binary missing");
    }
    const pi = new FakePi(handlers, spec);
    for (const [type, responder] of Object.entries(options.responders ?? {})) {
      pi.responders.set(type, responder);
    }
    pis.push(pi);
    return pi;
  });
  const workspaceDir = join(root, "data", "workspace", "repo");
  const stateFile = join(root, "data", "state", "session.json");
  const sessionDir = join(root, "sessions");
  const logs: string[] = [];
  const stateStore = new SessionStateStore({ file: stateFile, logError: (m) => logs.push(m) });
  const history =
    options.withoutHistory === true
      ? undefined
      : new HistoryStore({
          file: join(root, "data", "state", "history.json"),
          sessionDir,
          logError: (m) => logs.push(m),
        });
  const manager = new SessionManager({
    events,
    redactor: createRedactor([SECRET]),
    git: realGit,
    startPi,
    workspaceDir,
    stateStore,
    history,
    pi: {
      piCli: join(root, "pi", "cli.js"),
      agentDir: join(root, "agent"),
      sessionDir,
      extensions: [join(root, "ext", "git.ts")],
      env: {},
    },
    defaultModel: "ollama/qwen3-coder:30b",
    remoteBase,
    logger: {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const created: Harness = {
    manager,
    events,
    stateStore,
    history,
    sessionDir,
    pis,
    startPi,
    workspaceDir,
    logs,
  };
  harnesses.push(created);
  return created;
}

/** A harness that is a gateway after a restart: its history is read from disk first. */
async function reopened(options: HarnessOptions = {}): Promise<Harness> {
  const h = harness(options);
  await h.history?.load();
  return h;
}

const REQUEST: CreateSessionRequest = {
  repo: "octo/hello",
  prompt: "Fix the README",
  baseBranch: "main",
};

function onlyPi(h: Harness): FakePi {
  const pi = h.pis.at(-1);
  if (pi === undefined) {
    throw new Error("no Pi was started");
  }
  return pi;
}

/**
 * Waits for the history writes still queued: the store has no flush, so each listed entry is upserted
 * again (the store serializes its writes). Resolves at once without a history.
 */
async function flushHistory(h: Harness): Promise<void> {
  if (h.history === undefined) {
    return;
  }
  for (const entry of await h.history.list()) {
    const { resumable: _resumable, ...record } = entry;
    await h.history.upsert(record);
  }
}

/** Resolves with the first event matching the predicate (replayed from the buffer, then live). */
function waitForEvent(
  events: EventLog,
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = 2000,
): Promise<StreamEvent> {
  const existing = events.since(0).events.find((stored) => predicate(stored.event));
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  return new Promise<StreamEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for an event"));
    }, timeoutMs);
    const unsubscribe = events.subscribe((stored) => {
      if (predicate(stored.event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(stored);
      }
    });
  });
}

/** The history is written in the background: polls until the listed entries are what the test expects. */
async function waitForHistory(
  h: Harness,
  predicate: (entries: HistoryEntry[]) => boolean,
  timeoutMs = 2000,
): Promise<HistoryEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await h.manager.history();
    if (predicate(entries)) {
      return entries;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the history");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const isStatus = (status: string) => (event: SessionEvent) =>
  event.type === "status" && event.status === status;

async function createAndRun(h: Harness, request: CreateSessionRequest = REQUEST): Promise<FakePi> {
  await h.manager.create(request);
  await waitForEvent(h.events, isStatus("running"));
  return onlyPi(h);
}

/** The events of a harness, without their ids and timestamps. */
function replayOf(h: Harness): SessionEvent[] {
  return h.events.since(0).events.map((stored) => stored.event);
}

/** Pi's conversation file of a session, as Pi writes it in its --session-dir. */
async function writePiSession(h: Harness, id: string): Promise<void> {
  await mkdir(h.sessionDir, { recursive: true });
  await writeFile(join(h.sessionDir, `2026-01-01T00-00-00_${id}.jsonl`), "{}\n");
}

/** The code of the SessionError thrown by a promise, or undefined if it resolves. */
async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SessionError ? error.code : `not a SessionError: ${String(error)}`;
  }
}

/** Runs a session to `ready`, writes its Pi file and closes it (forced: the branch may not be pushed). Returns its id. */
async function closedSession(h: Harness): Promise<string> {
  const pi = await createAndRun(h);
  pi.emit({ type: "agent_settled" });
  await waitForHistory(h, (entries) => entries.some((entry) => entry.status === "ready"));
  // The stats are asked after the run checkpoint: waiting for them, the checkpoint is over before close.
  await vi.waitFor(() => {
    expect(pi.send.mock.calls.map(([command]) => command.type)).toContain("get_session_stats");
  });
  const id = h.manager.get()?.id;
  if (id === undefined) {
    throw new Error("no session");
  }
  await writePiSession(h, id);
  await h.manager.close({ force: true });
  return id;
}

describe("SessionManager history (feature 10, ADR-0011 §6)", () => {
  it("lists the current session as open and not resumable, with no stats yet", async () => {
    const h = harness();
    const pi = await createAndRun(h);
    pi.emit({ type: "agent_settled" });

    const [entry] = await waitForHistory(h, (entries) =>
      entries.some((item) => item.status === "ready"),
    );

    expect(entry).toEqual({
      id: h.manager.get()?.id,
      repo: "octo/hello",
      baseBranch: "main",
      branch: "agent/fix-the-readme",
      pr: null,
      mode: "auto",
      model: "ollama/qwen3-coder:30b",
      createdAt: expect.any(String),
      closedAt: null,
      status: "ready",
      stats: null,
      resumable: false,
    });
  });

  it("keeps the stats read from Pi after a run", async () => {
    const h = harness({ responders: { get_session_stats: () => PI_STATS } });
    const pi = await createAndRun(h);

    pi.emit({ type: "agent_settled" });

    const [entry] = await waitForHistory(h, (entries) => entries[0]?.stats != null);
    expect(entry?.stats).toEqual(STATS);
    expect(pi.send).toHaveBeenCalledWith({ type: "get_session_stats" }, { timeoutMs: undefined });
  });

  it("writes the closed entry with the last stats and resumable when the Pi file exists", async () => {
    const h = harness({ responders: { get_session_stats: () => PI_STATS } });
    await createAndRun(h);
    const id = h.manager.get()?.id;
    if (id === undefined) {
      throw new Error("no session");
    }
    await writePiSession(h, id);

    await h.manager.close({ force: true });

    const [entry] = await waitForHistory(h, (entries) => entries[0]?.closedAt != null);
    expect(entry).toMatchObject({
      id,
      status: "closed",
      stats: STATS,
      resumable: true,
      closedAt: expect.any(String),
    });
    expect(onlyPi(h).send).toHaveBeenCalledWith({ type: "get_session_stats" }, { timeoutMs: 5000 });
  });

  it("closes a session with its branch pushed without force", async () => {
    const h = harness();
    await createAndRun(h);
    const id = h.manager.get()?.id;
    await realGit(["push", "origin", "agent/fix-the-readme"], { cwd: h.workspaceDir });
    if (id === undefined) {
      throw new Error("no session");
    }
    await writePiSession(h, id);

    await h.manager.close({ force: false });

    const [entry] = await waitForHistory(h, (entries) => entries[0]?.closedAt != null);
    expect(entry).toMatchObject({ id, status: "closed", resumable: true });
  });

  it("writes a closed session without its Pi file as not resumable", async () => {
    const h = harness();
    await createAndRun(h);

    await h.manager.close({ force: true });

    const [entry] = await waitForHistory(h, (entries) => entries[0]?.closedAt != null);
    expect(entry).toMatchObject({ status: "closed", resumable: false });
  });

  it("keeps the stats of the history when the gateway restores the session", async () => {
    const first = harness({ responders: { get_session_stats: () => PI_STATS } });
    const pi = await createAndRun(first);
    pi.emit({ type: "agent_settled" });
    await waitForHistory(first, (entries) => entries[0]?.stats != null);
    const id = first.manager.get()?.id;
    await first.manager.shutdown();

    const second = await reopened();
    await second.manager.restore();
    // The record written by the restore is queued before this flush, so it is on disk when it ends.
    await flushHistory(second);

    expect(await second.manager.history()).toEqual([
      expect.objectContaining({ id, status: "ready", closedAt: null, stats: STATS }),
    ]);
  });

  it("lists the sessions of an earlier process from the history file", async () => {
    const first = harness();
    const id = await closedSession(first);

    const second = await reopened();

    expect(await second.manager.history()).toEqual([
      expect.objectContaining({
        id,
        closedAt: expect.any(String),
        status: "closed",
        resumable: true,
      }),
    ]);
  });

  it("has no history and records nothing without one", async () => {
    const h = harness({ withoutHistory: true });
    await createAndRun(h);
    await h.manager.close({ force: true });

    expect(await h.manager.history()).toEqual([]);
    expect(await errorCodeOf(h.manager.resume("anything", {}))).toBe("history_not_found");
  });
});

describe("SessionManager.resume (feature 10, ADR-0011 §7)", () => {
  it("re-clones the pushed branch with the same id, reopens Pi and replays it", async () => {
    const first = harness();
    const pi = await createAndRun(first);
    const id = first.manager.get()?.id;
    if (id === undefined) {
      throw new Error("no session");
    }
    await writeFile(join(first.workspaceDir, "notes.txt"), "work\n");
    await realGit(["add", "notes.txt"], { cwd: first.workspaceDir });
    await realGit(["commit", "-m", "work"], { cwd: first.workspaceDir });
    await realGit(["push", "origin", "agent/fix-the-readme"], { cwd: first.workspaceDir });
    await writePiSession(first, id);
    await first.manager.close({ force: false });
    expect(pi.stop).toHaveBeenCalled();

    const second = await reopened();
    const info = await second.manager.resume(id, {});

    expect(info).toMatchObject({
      id,
      status: "cloning",
      repo: "octo/hello",
      baseBranch: "main",
      branch: "agent/fix-the-readme",
      autoPush: false,
      pendingQuestions: [],
    });
    await waitForEvent(second.events, (event) => event.type === "history");
    expect(second.manager.get()?.status).toBe("ready");

    const head = await realGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: second.workspaceDir,
    });
    expect(head.stdout.trim()).toBe("agent/fix-the-readme");
    expect(await readFile(join(second.workspaceDir, "notes.txt"), "utf8")).toBe("work\n");

    expect(second.startPi).toHaveBeenCalledTimes(1);
    const args = onlyPi(second).spec.args;
    expect(args[args.indexOf("--session-id") + 1]).toBe(id);

    expect(replayOf(second)).toEqual([
      { type: "status", status: "cloning" },
      {
        type: "checkpoint",
        action: "created",
        checkpoint: expect.objectContaining({ id: 0, reason: "start" }),
      },
      { type: "status", status: "ready" },
      { type: "history", messages: [{ role: "user", content: "hi" }] },
    ]);
  });

  it("creates the branch from the base when it was never pushed", async () => {
    const first = harness();
    const id = await closedSession(first);

    const second = await reopened();
    await second.manager.resume(id, {});
    await waitForEvent(second.events, (event) => event.type === "history");

    expect(second.manager.get()).toMatchObject({ status: "ready", branch: "agent/fix-the-readme" });
    const head = await realGit(["rev-parse", "HEAD"], { cwd: second.workspaceDir });
    const base = await realGit(["rev-parse", "origin/main"], { cwd: second.workspaceDir });
    expect(head.stdout).toBe(base.stdout);
  });

  it("sends the prompt to Pi when one is given", async () => {
    const first = harness();
    const id = await closedSession(first);

    const second = await reopened();
    await second.manager.resume(id, { prompt: "Continue with the tests" });
    await waitForEvent(second.events, isStatus("running"));

    expect(onlyPi(second).send).toHaveBeenCalledWith({
      type: "prompt",
      message: "Continue with the tests",
    });
  });

  it("resumes with the stats of the history", async () => {
    const first = harness({ responders: { get_session_stats: () => PI_STATS } });
    const pi = await createAndRun(first);
    pi.emit({ type: "agent_settled" });
    await waitForHistory(first, (entries) => entries[0]?.stats != null);
    const id = first.manager.get()?.id;
    if (id === undefined) {
      throw new Error("no session");
    }
    await writePiSession(first, id);
    await first.manager.close({ force: true });

    const second = await reopened();
    await second.manager.resume(id, {});

    const [entry] = await waitForHistory(second, (entries) => entries[0]?.closedAt === null);
    expect(entry).toMatchObject({ id, status: "cloning", stats: STATS });
  });

  it("answers history_not_found for an unknown id", async () => {
    const h = harness();

    expect(await errorCodeOf(h.manager.resume("missing", {}))).toBe("history_not_found");
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("answers invalid_state for the current session", async () => {
    const h = harness({ failStart: true });
    await h.manager.create(REQUEST);
    await waitForEvent(h.events, isStatus("error"));
    const id = h.manager.get()?.id;
    if (id === undefined) {
      throw new Error("no session");
    }

    expect(await errorCodeOf(h.manager.resume(id, {}))).toBe("invalid_state");
    expect(h.manager.get()?.status).toBe("error");
  });

  it("answers invalid_state for a session without branch", async () => {
    const h = harness();
    await h.manager.create({ ...REQUEST, repo: "octo/missing" });
    await waitForEvent(h.events, isStatus("error"));
    const id = h.manager.get()?.id;
    if (id === undefined) {
      throw new Error("no session");
    }
    await h.manager.close({ force: true });
    await writePiSession(h, id);

    expect(await errorCodeOf(h.manager.resume(id, {}))).toBe("invalid_state");
  });

  it("answers invalid_state when the conversation file is gone and leaves the workspace alone", async () => {
    const h = harness();
    const id = await closedSession(h);
    await rm(join(h.sessionDir, `2026-01-01T00-00-00_${id}.jsonl`));
    await mkdir(h.workspaceDir, { recursive: true });
    await writeFile(join(h.workspaceDir, "keep.txt"), "keep\n");

    expect(await errorCodeOf(h.manager.resume(id, {}))).toBe("invalid_state");
    expect(existsSync(join(h.workspaceDir, "keep.txt"))).toBe(true);
    expect(h.startPi).toHaveBeenCalledTimes(1);
  });

  it("answers session_exists while another session is active", async () => {
    const h = harness();
    const id = await closedSession(h);
    await h.manager.create(REQUEST);

    expect(await errorCodeOf(h.manager.resume(id, {}))).toBe("session_exists");
  });
});
