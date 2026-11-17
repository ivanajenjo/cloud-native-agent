import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CreateSessionRequest, SessionEvent, StreamEvent, TodoItem } from "@cna/shared";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/events/event-log.js";
import type { PiLaunchSpec } from "../src/pi/launch.js";
import { createRedactor } from "../src/redact.js";
import type { RpcBridgeHandlers, RpcCommandInput, RpcEvent } from "../src/rpc/bridge.js";
import { type PiProcess, SessionManager } from "../src/session/manager.js";
import { type PersistedSession, SessionStateStore } from "../src/session/persistence.js";
import { createGitRunner } from "../src/workspace/git.js";

const SECRET = "ghp_supersecret123";

/** Warning of a restart that lost a run or pending questions (manager.ts LOST_RUN_MESSAGE). */
const LOST_RUN_MESSAGE =
  "La ejecución en curso o las preguntas pendientes se perdieron al reiniciar el gateway; vuelve a pedírselo al agente.";

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

let root: string;
let remoteBase: string;
let harnesses: Harness[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-session-restore-"));

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
  stateFile: string;
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
}

/**
 * A manager over the same data dir as every other harness of this test: a second harness is the
 * gateway after a restart (same workspace dir, same state file).
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
  const logs: string[] = [];
  const stateStore = new SessionStateStore({ file: stateFile, logError: (m) => logs.push(m) });
  const manager = new SessionManager({
    events,
    redactor: createRedactor([SECRET]),
    git: realGit,
    startPi,
    workspaceDir,
    stateStore,
    pi: {
      piCli: join(root, "pi", "cli.js"),
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
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
    stateFile,
    pis,
    startPi,
    workspaceDir,
    logs,
  };
  harnesses.push(created);
  return created;
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

/** The state file is written in the background: polls until it holds what the test expects. */
async function waitForSavedState(
  store: SessionStateStore,
  predicate: (state: PersistedSession) => boolean,
  timeoutMs = 2000,
): Promise<PersistedSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await store.load();
    if (state !== null && predicate(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the saved state");
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

function selectRequest(id: string, title: string, options: string[]): RpcExtensionUIRequest {
  return { type: "extension_ui_request", id, method: "select", title, options };
}

function todoEnd(toolCallId: string, todos: unknown[]): RpcEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "todo",
    result: { content: [{ type: "text", text: "ok" }], details: { todos } },
    isError: false,
  };
}

const FIRST: TodoItem[] = [{ id: 1, text: "Read the code", status: "in_progress" }];

/** The events of a harness, without their ids and timestamps. */
function replayOf(h: Harness): SessionEvent[] {
  return h.events.since(0).events.map((stored) => stored.event);
}

/** A state file as a previous gateway process would have left it. */
function savedState(info: Partial<PersistedSession["info"]> = {}): PersistedSession {
  return {
    version: 1,
    info: {
      id: "sess-restored",
      status: "ready",
      repo: "octo/hello",
      baseBranch: "main",
      branch: "agent/fix-the-readme",
      model: null,
      thinking: null,
      mode: "auto",
      autoPush: false,
      createdAt: new Date(0).toISOString(),
      pr: null,
      ...info,
    },
    todos: [],
    checkpoints: [],
    baselineTree: null,
  };
}

async function writeSavedState(h: Harness, state: PersistedSession): Promise<void> {
  await mkdir(dirname(h.stateFile), { recursive: true });
  await writeFile(h.stateFile, JSON.stringify(state));
}

/** A workspace that is left over on disk. `repository` adds the `.git` dir a clone would have. */
async function leftoverWorkspace(h: Harness, repository: boolean): Promise<void> {
  await mkdir(h.workspaceDir, { recursive: true });
  await writeFile(join(h.workspaceDir, "leftover.txt"), "old\n");
  if (repository) {
    await mkdir(join(h.workspaceDir, ".git"));
  }
}

/** Runs a session to `ready` on a first manager, then stops that manager as a gateway restart does. */
async function readySessionBeforeRestart(): Promise<{ first: Harness; id: string }> {
  const first = harness();
  const pi = await createAndRun(first);
  pi.emit({ type: "agent_settled" });
  await waitForSavedState(first.stateStore, (state) => state.info.status === "ready");
  const id = first.manager.get()?.id;
  if (id === undefined) {
    throw new Error("no session");
  }
  await first.manager.shutdown();
  return { first, id };
}

describe("SessionManager state persistence (ADR-0011 §2)", () => {
  it("saves the session info, the branch and the start checkpoint", async () => {
    const h = harness();
    const pi = await createAndRun(h);
    pi.emit({ type: "agent_settled" });

    const state = await waitForSavedState(h.stateStore, (saved) => saved.info.status === "ready");
    expect(state.version).toBe(1);
    expect(state.info.id).toBe(h.manager.get()?.id);
    expect(state.info.branch).toBe("agent/fix-the-readme");
    expect(state.info.baseBranch).toBe("main");
    expect(state.info).not.toHaveProperty("suspended");
    expect(state.info).not.toHaveProperty("pendingQuestions");
    expect(state.checkpoints.map((record) => record.checkpoint)).toEqual([
      expect.objectContaining({ id: 0, reason: "start" }),
    ]);
  });

  it("saves the task list after a todo event", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    pi.emit(todoEnd("call-1", FIRST));

    const state = await waitForSavedState(h.stateStore, (saved) => saved.todos.length === 1);
    expect(state.todos).toEqual(FIRST);
  });

  it("removes the saved state on close", async () => {
    const h = harness();
    const pi = await createAndRun(h);
    pi.emit({ type: "agent_settled" });
    await waitForSavedState(h.stateStore, (saved) => saved.info.status === "ready");

    await h.manager.close({ force: true });

    expect(existsSync(h.stateFile)).toBe(false);
    expect(await h.stateStore.load()).toBeNull();
  });
});

describe("SessionManager.restore (ADR-0011 §3)", () => {
  it("resumes a ready session with the same id, task list and checkpoints, and replays the history", async () => {
    const first = harness();
    const pi = await createAndRun(first);
    await writeFile(join(first.workspaceDir, "notes.txt"), "work\n");
    pi.emit(todoEnd("call-1", FIRST));
    pi.emit({ type: "agent_settled" });
    const saved = await waitForSavedState(
      first.stateStore,
      (state) => state.info.status === "ready" && state.checkpoints.length === 2,
    );
    const id = first.manager.get()?.id;
    await first.manager.shutdown();

    const second = harness();
    await second.manager.restore();

    const info = second.manager.get();
    expect(info?.status).toBe("ready");
    expect(info?.id).toBe(id);
    expect(info?.branch).toBe(saved.info.branch);
    expect(info?.pendingQuestions).toEqual([]);
    expect(second.manager.todos()).toEqual(FIRST);
    expect(second.manager.checkpoints()).toEqual(first.manager.checkpoints());
    expect(second.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);

    expect(second.startPi).toHaveBeenCalledTimes(1);
    const args = onlyPi(second).spec.args;
    expect(args[args.indexOf("--session-id") + 1]).toBe(id);

    expect(replayOf(second)).toEqual([
      { type: "status", status: "ready" },
      { type: "history", messages: [{ role: "user", content: "hi" }] },
    ]);
    // The restored state is written again by the new process.
    await waitForSavedState(second.stateStore, (state) => state.info.id === id);
  });

  it("warns after the history when the restart lost a run in progress", async () => {
    const first = harness();
    await createAndRun(first);
    await waitForSavedState(first.stateStore, (state) => state.info.status === "running");
    await first.manager.shutdown();

    const second = harness();
    await second.manager.restore();

    expect(second.manager.get()?.status).toBe("ready");
    expect(replayOf(second)).toEqual([
      { type: "status", status: "ready" },
      { type: "history", messages: [{ role: "user", content: "hi" }] },
      { type: "notify", level: "warning", message: LOST_RUN_MESSAGE },
    ]);
  });

  it("resumes a session that waited for input with no pending question, and warns", async () => {
    const first = harness();
    const pi = await createAndRun(first);
    pi.ui(selectRequest("q1", "cna:ask_user:Which one?", ["a", "b"]));
    await waitForSavedState(first.stateStore, (state) => state.info.status === "waiting_input");
    await first.manager.shutdown();

    const second = harness();
    await second.manager.restore();

    expect(second.manager.get()?.status).toBe("ready");
    expect(second.manager.get()?.pendingQuestions).toEqual([]);
    expect(replayOf(second)).toEqual([
      { type: "status", status: "ready" },
      { type: "history", messages: [{ role: "user", content: "hi" }] },
      { type: "notify", level: "warning", message: LOST_RUN_MESSAGE },
    ]);
  });

  it("ends a session that was being cloned in error, without starting Pi", async () => {
    const h = harness();
    await writeSavedState(h, savedState({ status: "cloning", baseBranch: null, branch: null }));
    await leftoverWorkspace(h, true);

    await h.manager.restore();

    const message = "the gateway restarted while the repository was being cloned";
    expect(h.manager.get()?.status).toBe("error");
    expect(h.manager.get()?.error).toBe(message);
    expect(h.startPi).not.toHaveBeenCalled();
    expect(replayOf(h)).toEqual([{ type: "status", status: "error", error: message }]);
  });

  it("keeps a session in error in error and replays why", async () => {
    const h = harness();
    await writeSavedState(h, savedState({ status: "error", error: "clone failed" }));
    await leftoverWorkspace(h, true);

    await h.manager.restore();

    expect(h.manager.get()?.status).toBe("error");
    expect(h.startPi).not.toHaveBeenCalled();
    expect(replayOf(h)).toEqual([{ type: "status", status: "error", error: "clone failed" }]);
  });

  it("removes a leftover workspace when there is no saved state", async () => {
    const h = harness();
    await leftoverWorkspace(h, true);

    await h.manager.restore();

    expect(existsSync(h.workspaceDir)).toBe(false);
    expect(h.manager.get()).toBeNull();
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("discards a saved state whose workspace has no repository", async () => {
    const h = harness();
    await writeSavedState(h, savedState());
    await leftoverWorkspace(h, false);

    await h.manager.restore();

    expect(h.manager.get()).toBeNull();
    expect(existsSync(h.stateFile)).toBe(false);
    expect(existsSync(h.workspaceDir)).toBe(false);
    expect(h.logs).toContain("session state discarded: the workspace has no repository");
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("discards a saved state of a closed session", async () => {
    const h = harness();
    await writeSavedState(h, savedState({ status: "closed" }));
    await leftoverWorkspace(h, true);

    await h.manager.restore();

    expect(h.manager.get()).toBeNull();
    expect(existsSync(h.stateFile)).toBe(false);
    expect(existsSync(h.workspaceDir)).toBe(false);
    expect(h.logs).toContain("session state discarded: the session was closed");
  });

  it("resumes with an empty history and logs the error when get_messages fails", async () => {
    const { id } = await readySessionBeforeRestart();

    const second = harness({
      responders: {
        get_messages: () => {
          throw new Error("rpc broke");
        },
      },
    });
    await second.manager.restore();

    expect(second.manager.get()).toMatchObject({ id, status: "ready" });
    expect(replayOf(second)).toEqual([
      { type: "status", status: "ready" },
      { type: "history", messages: [] },
    ]);
    expect(second.logs.some((line) => line.includes("rpc broke"))).toBe(true);
  });

  it("redacts secrets of the conversation sent as history", async () => {
    await readySessionBeforeRestart();

    const second = harness({
      responders: {
        get_messages: () => ({
          messages: [{ role: "user", content: `token ${SECRET}` }],
        }),
      },
    });
    await second.manager.restore();

    const dump = JSON.stringify(replayOf(second));
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain("[REDACTED]");
  });

  it("ends in error, and never throws, when Pi does not start", async () => {
    await readySessionBeforeRestart();

    const second = harness({ failStart: true });
    await expect(second.manager.restore()).resolves.toBeUndefined();

    expect(second.manager.get()?.status).toBe("error");
    expect(second.manager.get()?.error).toBe("pi binary missing");
    expect(replayOf(second)).toEqual([
      { type: "status", status: "error", error: "pi binary missing" },
    ]);
  });
});
