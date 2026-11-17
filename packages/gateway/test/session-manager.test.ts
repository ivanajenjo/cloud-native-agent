import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CreateSessionRequest,
  Question,
  SessionEvent,
  StreamEvent,
  TodoItem,
} from "@cna/shared";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/events/event-log.js";
import type { ToolLog } from "../src/logs/tool-log.js";
import type { Notification, Notifier } from "../src/notifications/notifier.js";
import type { PiLaunchSpec } from "../src/pi/launch.js";
import { createRedactor } from "../src/redact.js";
import {
  type RpcBridgeHandlers,
  RpcCommandError,
  type RpcCommandInput,
  type RpcEvent,
} from "../src/rpc/bridge.js";
import { type PiProcess, SessionManager } from "../src/session/manager.js";
import { SessionError } from "../src/session/service.js";
import { createGitRunner, GitError, type GitRunner } from "../src/workspace/git.js";

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

let root: string;
let remoteBase: string;
let harnesses: Harness[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-session-manager-"));

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

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.handlers.onExit({ code, signal, expected: false });
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

type GitWrapper = (real: GitRunner) => GitRunner;

interface Harness {
  manager: SessionManager;
  events: EventLog;
  pis: FakePi[];
  startPi: ReturnType<typeof vi.fn>;
  workspaceDir: string;
  logs: string[];
}

interface HarnessOptions {
  webConfigFile?: string;
  toolLog?: ToolLog;
  notifier?: Notifier;
  idleTimeoutMs?: number;
}

function harness(wrapGit: GitWrapper = (real) => real, options: HarnessOptions = {}): Harness {
  const events = new EventLog();
  const pis: FakePi[] = [];
  const startPi = vi.fn((spec: PiLaunchSpec, handlers: RpcBridgeHandlers) => {
    const pi = new FakePi(handlers, spec);
    pis.push(pi);
    return pi;
  });
  const workspaceDir = join(root, "data", "workspace", "repo");
  const logs: string[] = [];
  const manager = new SessionManager({
    events,
    redactor: createRedactor([SECRET]),
    git: wrapGit(realGit),
    startPi,
    workspaceDir,
    pi: {
      piCli: join(root, "pi", "cli.js"),
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensions: [join(root, "ext", "git.ts")],
      ...(options.webConfigFile !== undefined ? { webConfigFile: options.webConfigFile } : {}),
      env: {},
    },
    ...(options.toolLog !== undefined ? { toolLog: options.toolLog } : {}),
    defaultModel: "ollama/qwen3-coder:30b",
    remoteBase,
    ...(options.notifier !== undefined ? { notifier: options.notifier } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    logger: {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const created: Harness = { manager, events, pis, startPi, workspaceDir, logs };
  harnesses.push(created);
  return created;
}

const REQUEST = { repo: "octo/hello", prompt: "Fix the README" };

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

const isStatus = (status: string) => (event: SessionEvent) =>
  event.type === "status" && event.status === status;

async function createAndRun(h: Harness, request: CreateSessionRequest = REQUEST): Promise<FakePi> {
  await h.manager.create(request);
  await waitForEvent(h.events, isStatus("running"));
  return onlyPi(h);
}

function selectRequest(
  id: string,
  title: string,
  options: string[],
  timeout?: number,
): RpcExtensionUIRequest {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options,
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function confirmRequest(id: string, title: string): RpcExtensionUIRequest {
  return { type: "extension_ui_request", id, method: "confirm", title, message: "Sure?" };
}

function networkQuestion(id: string): Question {
  return {
    id,
    kind: "network",
    method: "select",
    title: "Allow example.com:443?",
    options: ["allow_once", "allow_always", "deny"],
    createdAt: new Date(0).toISOString(),
    network: { host: "example.com", port: 443 },
  };
}

function eventTypes(h: Harness): string[] {
  return h.events.since(0).events.map((stored) => stored.event.type);
}

describe("SessionManager", () => {
  it("returns cloning, then starts Pi on the workspace with the prompt", async () => {
    const h = harness();
    const info = await h.manager.create({ ...REQUEST, baseBranch: "main" });

    expect(info.status).toBe("cloning");
    expect(info.model).toBe("ollama/qwen3-coder:30b");
    expect(info.pendingQuestions).toEqual([]);

    await waitForEvent(h.events, isStatus("running"));
    const pi = onlyPi(h);
    expect(h.startPi).toHaveBeenCalledTimes(1);
    expect(pi.spec.cwd).toBe(h.workspaceDir);
    expect(pi.spec.args).toEqual(
      expect.arrayContaining(["--cna-base-branch", "main", "--model", "ollama/qwen3-coder:30b"]),
    );
    expect(pi.send).toHaveBeenCalledWith({ type: "prompt", message: "Fix the README" });

    const running = h.manager.get();
    expect(running?.status).toBe("running");
    expect(running?.branch).toBe("agent/fix-the-readme");
    expect(running?.baseBranch).toBe("main");
  });

  it("keeps running until agent_settled, and streams message and retry events", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    pi.emit({ type: "agent_start" });
    pi.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hola" },
    });
    pi.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hola" }] },
    });
    pi.emit({ type: "agent_end", messages: [], willRetry: true });
    expect(h.manager.get()?.status).toBe("running");

    pi.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10 });
    pi.emit({ type: "agent_start" });
    pi.emit({ type: "agent_end", messages: [] });
    expect(h.manager.get()?.status).toBe("running");

    pi.emit({ type: "agent_settled" });
    expect(h.manager.get()?.status).toBe("ready");

    expect(eventTypes(h)).toEqual(expect.arrayContaining(["message_delta", "message", "retry"]));
  });

  it("redacts secrets from events", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    pi.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: `token ${SECRET}`,
      },
    });
    pi.emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: `out ${SECRET}` }] },
      isError: false,
    });

    const dump = JSON.stringify(h.events.since(0).events);
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain("[REDACTED]");
  });

  it("logs Pi stderr and protocol errors redacted and cut to 500 characters", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    pi.handlers.onStderr?.(`${SECRET} ${"x".repeat(1000)}`);
    pi.handlers.onProtocolError?.(`bad record ${SECRET}`);

    const dump = h.logs.join("\n");
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain("pi: [REDACTED] ");
    expect(dump).toContain("pi protocol: bad record [REDACTED]");
    const piLine = h.logs.find((line) => line.startsWith("pi: "));
    expect(piLine?.length).toBeLessThanOrEqual("pi: ".length + 500);
  });

  it("waits for several Pi questions and answers them one by one", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    pi.ui(selectRequest("q1", "cna:ask_user:Which one?", ["a", "b"]));
    pi.ui(confirmRequest("q2", "cna:confirm:Push?"));
    expect(h.manager.get()?.status).toBe("waiting_input");
    expect(h.manager.get()?.pendingQuestions.map((q) => q.id)).toEqual(["q1", "q2"]);

    await h.manager.answer("q1", { value: "a" });
    expect(h.manager.get()?.status).toBe("waiting_input");

    await h.manager.answer("q2", { confirmed: true });
    expect(h.manager.get()?.status).toBe("running");

    expect(pi.respondUi.mock.calls).toEqual([
      [{ type: "extension_ui_response", id: "q1", value: "a" }],
      [{ type: "extension_ui_response", id: "q2", confirmed: true }],
    ]);

    await expect(h.manager.answer("q1", { value: "a" })).rejects.toMatchObject({
      code: "question_resolved",
    });
    await expect(h.manager.answer("unknown", { value: "a" })).rejects.toMatchObject({
      code: "question_not_found",
    });

    pi.ui(selectRequest("q3", "cna:ask_user:Pick", ["x"]));
    await expect(h.manager.answer("q3", { value: "nope" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(h.manager.answer("q3", { confirmed: true })).rejects.toBeInstanceOf(SessionError);
    await h.manager.answer("q3", { value: "x" });
    expect(h.manager.get()?.pendingQuestions).toEqual([]);
  });

  it("resolves a question with a timeout without answering Pi", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    pi.ui(selectRequest("q5", "cna:ask_user:Quick?", ["yes"], 50));
    const resolved = await waitForEvent(
      h.events,
      (event) => event.type === "question_resolved" && event.questionId === "q5",
    );

    expect(resolved.event).toEqual({
      type: "question_resolved",
      questionId: "q5",
      outcome: "timeout",
    });
    expect(pi.respondUi).not.toHaveBeenCalled();
    expect(h.manager.get()?.pendingQuestions).toEqual([]);
  });

  it("abort cancels every pending Pi question and sends abort to Pi", async () => {
    const h = harness();
    const pi = await createAndRun(h);
    pi.ui(selectRequest("q1", "cna:ask_user:One?", ["a"]));
    pi.ui(confirmRequest("q2", "cna:confirm:Two?"));

    await h.manager.abort();

    expect(pi.respondUi).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "q1",
      cancelled: true,
    });
    expect(pi.respondUi).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "q2",
      cancelled: true,
    });
    expect(pi.send).toHaveBeenCalledWith({ type: "abort" }, { timeoutMs: 60_000 });
    expect(h.manager.get()?.pendingQuestions).toEqual([]);
    expect(h.manager.get()?.status).not.toBe("waiting_input");
  });

  it("postMessage uses streamingBehavior while running and a plain prompt when ready", async () => {
    const h = harness();
    const pi = await createAndRun(h);

    const followUp = await h.manager.postMessage({ text: "one more thing" });
    expect(followUp).toEqual({ disposition: "started" });
    expect(pi.send).toHaveBeenLastCalledWith({
      type: "prompt",
      message: "one more thing",
      streamingBehavior: "followUp",
    });

    await h.manager.postMessage({ text: "steer it", mode: "steer" });
    expect(pi.send).toHaveBeenLastCalledWith({
      type: "prompt",
      message: "steer it",
      streamingBehavior: "steer",
    });

    pi.emit({ type: "agent_settled" });
    expect(h.manager.get()?.status).toBe("ready");
    await h.manager.postMessage({ text: "next" });
    expect(pi.send).toHaveBeenLastCalledWith({ type: "prompt", message: "next" });
  });

  it("postMessage throws no_session without a session and invalid_state when Pi rejects", async () => {
    const empty = harness();
    await expect(empty.manager.postMessage({ text: "hi" })).rejects.toMatchObject({
      code: "no_session",
    });

    const h = harness();
    const pi = await createAndRun(h);
    pi.responders.set("prompt", () => {
      throw new RpcCommandError("agent is busy", "prompt", "failed");
    });
    await expect(h.manager.postMessage({ text: "hi" })).rejects.toMatchObject({
      code: "invalid_state",
      message: "agent is busy",
    });
  });

  it("refuses a second session while one is active", async () => {
    const h = harness();
    await h.manager.create(REQUEST);
    await expect(h.manager.create(REQUEST)).rejects.toMatchObject({ code: "session_exists" });
    await waitForEvent(h.events, isStatus("running"));
  });

  it("goes to error when the clone fails, and a new session can be created afterwards", async () => {
    const h = harness();
    await h.manager.create({ repo: "octo/missing", prompt: "Fix the README" });
    await waitForEvent(h.events, isStatus("error"));

    const failed = h.manager.get();
    expect(failed?.status).toBe("error");
    expect(failed?.error).toContain("git clone failed");
    expect(h.startPi).not.toHaveBeenCalled();

    await createAndRun(h);
    expect(h.manager.get()?.status).toBe("running");
  });

  it("cancels pending questions and goes to error when Pi dies unexpectedly", async () => {
    const h = harness();
    const pi = await createAndRun(h);
    pi.ui(selectRequest("q1", "cna:ask_user:Still there?", ["yes"]));

    pi.exit(1, null);

    const failed = h.manager.get();
    expect(failed?.status).toBe("error");
    expect(failed?.error).toBe("pi exited unexpectedly (code 1, signal null)");
    expect(failed?.pendingQuestions).toEqual([]);
    expect(h.events.since(0).events).toContainEqual(
      expect.objectContaining({
        event: { type: "question_resolved", questionId: "q1", outcome: "cancelled" },
      }),
    );
  });

  describe("close", () => {
    it("refuses uncommitted changes unless forced, then closes and removes the workspace", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      await writeFile(join(h.workspaceDir, "NOTES.md"), "pending\n");

      await expect(h.manager.close({ force: false })).rejects.toMatchObject({
        code: "invalid_state",
        message: "uncommitted changes",
      });
      expect(h.manager.get()).not.toBeNull();

      await h.manager.close({ force: true });
      expect(h.manager.get()).toBeNull();
      expect(existsSync(h.workspaceDir)).toBe(false);
      expect(pi.stop).toHaveBeenCalled();
      expect(h.events.since(0).events.at(-1)?.event).toEqual({ type: "status", status: "closed" });
      await expect(h.manager.close({ force: true })).rejects.toMatchObject({
        code: "no_session",
      });
    });

    it("refuses commits that are not pushed, and closes a clean workspace", async () => {
      const h = harness();
      await createAndRun(h);
      await writeFile(join(h.workspaceDir, "NOTES.md"), "pending\n");
      await realGit(["add", "NOTES.md"], { cwd: h.workspaceDir });
      await realGit(["commit", "-m", "local work"], { cwd: h.workspaceDir });

      await expect(h.manager.close({ force: false })).rejects.toMatchObject({
        code: "invalid_state",
        message: "commits not pushed",
      });

      await h.manager.close({ force: true });
      expect(h.manager.get()).toBeNull();

      const clean = harness();
      await createAndRun(clean);
      await clean.manager.close({ force: false });
      expect(clean.manager.get()).toBeNull();
    });

    it("does not start Pi when closed during the clone", async () => {
      let cloneStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        cloneStarted = resolve;
      });
      let releaseClone!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseClone = resolve;
      });
      let cloneFinished!: () => void;
      const finished = new Promise<void>((resolve) => {
        cloneFinished = resolve;
      });
      const h = harness((real) => async (args, options) => {
        if (args[0] !== "clone") {
          return real(args, options);
        }
        cloneStarted();
        await gate;
        try {
          return await real(args, options);
        } finally {
          cloneFinished();
        }
      });

      await h.manager.create(REQUEST);
      await started;
      await h.manager.close({ force: true });
      expect(h.manager.get()).toBeNull();

      releaseClone();
      await finished;
      // The stale job removes the clone it finished after the close.
      for (let attempt = 0; attempt < 200 && existsSync(h.workspaceDir); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(existsSync(h.workspaceDir)).toBe(false);
      expect(h.startPi).not.toHaveBeenCalled();
      expect(h.manager.get()).toBeNull();
    });
  });

  describe("network questions", () => {
    it("is refused without a session", () => {
      const h = harness();
      expect(h.manager.publishNetworkQuestion(networkQuestion("net-1"))).toBe(false);
      h.manager.publishNetworkEntry({
        ts: new Date(0).toISOString(),
        method: "CONNECT",
        host: "example.com",
        port: 443,
        decision: "deny",
        reason: "no_session",
        bytesOut: 0,
        bytesIn: 0,
        durationMs: 0,
      });
      expect(h.events.since(0).events).toEqual([]);
    });

    it("is published while the session is active, and resolved once", async () => {
      const h = harness();
      await createAndRun(h);

      expect(h.manager.publishNetworkQuestion(networkQuestion("net-1"))).toBe(true);
      expect(h.manager.publishNetworkQuestion(networkQuestion("net-1"))).toBe(true);
      expect(h.manager.get()?.status).toBe("waiting_input");
      expect(h.manager.get()?.pendingQuestions.map((q) => q.id)).toEqual(["net-1"]);

      expect(h.manager.resolveNetworkQuestion("net-1", "answered")).toBe(true);
      expect(h.manager.get()?.status).toBe("running");
      expect(h.manager.resolveNetworkQuestion("net-1", "answered")).toBe(false);

      await expect(h.manager.answer("net-1", { value: "deny" })).rejects.toMatchObject({
        code: "question_not_found",
      });
    });

    it("publishes network entries only with a session", async () => {
      const h = harness();
      await createAndRun(h);
      h.manager.publishNetworkEntry({
        ts: new Date(0).toISOString(),
        method: "CONNECT",
        host: "example.com",
        port: 443,
        decision: "allow",
        reason: "allowlist",
        bytesOut: 10,
        bytesIn: 20,
        durationMs: 5,
      });
      expect(eventTypes(h)).toContain("network");
    });
  });

  describe("plan mode", () => {
    it("starts in plan mode with --cna-plan, and in auto mode without it by default", async () => {
      const planned = harness();
      await createAndRun(planned, { ...REQUEST, mode: "plan" });
      expect(planned.manager.get()?.mode).toBe("plan");
      expect(onlyPi(planned).spec.args).toContain("--cna-plan");

      const auto = harness();
      await createAndRun(auto);
      expect(auto.manager.get()?.mode).toBe("auto");
      expect(onlyPi(auto).spec.args).not.toContain("--cna-plan");
    });

    it("switches to auto and emits mode once when the plan is approved, and not again", async () => {
      const h = harness();
      const pi = await createAndRun(h, { ...REQUEST, mode: "plan" });
      const modeEntry = {
        type: "entry_appended",
        entry: { type: "custom", customType: "cna.mode", data: { mode: "auto" } },
      };

      pi.emit(modeEntry);
      expect(h.manager.get()?.mode).toBe("auto");
      pi.emit(modeEntry);

      const modes = h.events.since(0).events.filter((stored) => stored.event.type === "mode");
      expect(modes.map((stored) => stored.event)).toEqual([{ type: "mode", mode: "auto" }]);
    });
  });

  describe("task list", () => {
    function todoEnd(toolCallId: string, todos: unknown[], isError = false): RpcEvent {
      return {
        type: "tool_execution_end",
        toolCallId,
        toolName: "todo",
        result: { content: [{ type: "text", text: "ok" }], details: { todos } },
        isError,
      };
    }

    const FIRST = [{ id: 1, text: "Read the code", status: "in_progress" }];
    const SECOND = [
      { id: 1, text: "Read the code", status: "completed" },
      { id: 2, text: "Write the tests", status: "pending" },
    ];

    it("emits todo after a valid todo call and replaces the list on the next one", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      expect(h.manager.todos()).toEqual([]);

      pi.emit(todoEnd("call-1", FIRST));
      expect(h.events.since(0).events).toContainEqual(
        expect.objectContaining({ event: { type: "todo", todos: FIRST } }),
      );
      expect(h.manager.todos()).toEqual(FIRST);

      pi.emit(todoEnd("call-2", SECOND));
      expect(h.manager.todos()).toEqual(SECOND);
    });

    it("returns a copy of the list", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.emit(todoEnd("call-1", FIRST));

      h.manager.todos()[0] = { id: 9, text: "changed", status: "pending" };
      expect(h.manager.todos()).toEqual(FIRST);
    });

    it("ignores a todo call that failed: no event and the list does not change", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.emit(todoEnd("call-1", FIRST));
      const before = h.events.lastId;

      pi.emit(todoEnd("call-2", SECOND, true));

      expect(h.events.lastId).toBe(before + 1);
      expect(eventTypes(h).filter((type) => type === "todo")).toHaveLength(1);
      expect(h.manager.todos()).toEqual(FIRST);
    });

    it("throws no_session without a session, and a new session starts empty", async () => {
      const h = harness();
      expect(() => h.manager.todos()).toThrow(SessionError);
      let caught: unknown;
      try {
        h.manager.todos();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "no_session" });

      const pi = await createAndRun(h);
      pi.emit(todoEnd("call-1", FIRST));
      await h.manager.close({ force: true });
      expect(h.manager.get()).toBeNull();

      await createAndRun(h);
      expect(h.manager.todos()).toEqual([]);
    });
  });

  describe("tool log", () => {
    it("records the start and the end of a tool with the session id", async () => {
      const toolLog = { start: vi.fn(), end: vi.fn(), close: vi.fn(async () => undefined) };
      const h = harness(undefined, { toolLog });
      const pi = await createAndRun(h);
      const sessionId = h.manager.get()?.id;

      pi.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      pi.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "README.md" }] },
        isError: false,
        durationMs: 12,
      });

      expect(toolLog.start).toHaveBeenCalledWith(sessionId, {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      expect(toolLog.end).toHaveBeenCalledWith(sessionId, {
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "README.md" }] },
        isError: false,
        durationMs: 12,
      });
    });

    it("keeps emitting the session events when the tool log throws", async () => {
      const toolLog = {
        start: vi.fn(() => {
          throw new Error("disk full");
        }),
        end: vi.fn(() => {
          throw new Error("disk full");
        }),
        close: vi.fn(async () => undefined),
      };
      const h = harness(undefined, { toolLog });
      const pi = await createAndRun(h);

      expect(() =>
        pi.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: {},
        }),
      ).not.toThrow();
      pi.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: null,
        isError: false,
      });

      expect(toolLog.start).toHaveBeenCalledTimes(1);
      expect(eventTypes(h)).toContain("tool_start");
      expect(eventTypes(h)).toContain("tool_end");
      expect(h.logs).toContainEqual(expect.stringContaining("tool log: disk full"));
    });
  });

  describe("setModel", () => {
    it("splits the model at the first slash and sends the thinking level", async () => {
      const h = harness();
      const pi = await createAndRun(h);

      await h.manager.setModel({ model: "ollama/qwen3-coder:30b", thinking: "high" });
      expect(pi.send).toHaveBeenCalledWith({
        type: "set_model",
        provider: "ollama",
        modelId: "qwen3-coder:30b",
      });
      expect(pi.send).toHaveBeenCalledWith({ type: "set_thinking_level", level: "high" });
      expect(h.manager.get()).toMatchObject({
        model: "ollama/qwen3-coder:30b",
        thinking: "high",
      });

      await h.manager.setModel({ model: "openrouter/meta/llama:free" });
      expect(pi.send).toHaveBeenLastCalledWith({
        type: "set_model",
        provider: "openrouter",
        modelId: "meta/llama:free",
      });
    });

    it("maps a rejected model to unknown_model", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("set_model", () => {
        throw new RpcCommandError("model not found", "set_model", "failed");
      });

      await expect(h.manager.setModel({ model: "ollama/nope" })).rejects.toMatchObject({
        code: "unknown_model",
        message: "model not found",
      });
    });

    it("throws no_session without a session", async () => {
      const h = harness();
      await expect(h.manager.setModel({ model: "ollama/x" })).rejects.toMatchObject({
        code: "no_session",
      });
    });
  });

  it("passes the web config file to Pi with --cna-web-config", async () => {
    const webConfigFile = join(root, "config", "web.yaml");
    const h = harness(undefined, { webConfigFile });
    await createAndRun(h);

    const args = onlyPi(h).spec.args;
    expect(args[args.indexOf("--cna-web-config") + 1]).toBe(webConfigFile);
  });

  it("publishes no event for a second identical status and keeps the session readable", async () => {
    const h = harness();
    const pi = await createAndRun(h);
    const before = h.events.lastId;
    pi.emit({ type: "agent_start" });
    expect(h.events.lastId).toBe(before);
    expect(h.manager.get()?.status).toBe("running");
  });

  describe("checkpoints", () => {
    const FIRST_TODOS: TodoItem[] = [{ id: 1, text: "Read the code", status: "in_progress" }];
    const SECOND_TODOS: TodoItem[] = [
      { id: 1, text: "Read the code", status: "completed" },
      { id: 2, text: "Write the tests", status: "pending" },
    ];

    /** Fork messages (user messages Pi can fork from), as get_fork_messages lists them. */
    function forkMessages(entryIds: string[]): Array<{ entryId: string; text: string }> {
      return entryIds.map((entryId) => ({ entryId, text: `prompt ${entryId}` }));
    }

    function checkpointEvent(id: number, action: "created" | "restored") {
      return (event: SessionEvent) =>
        event.type === "checkpoint" && event.action === action && event.checkpoint.id === id;
    }

    function todoEnd(toolCallId: string, todos: TodoItem[]): RpcEvent {
      return {
        type: "tool_execution_end",
        toolCallId,
        toolName: "todo",
        result: { content: [{ type: "text", text: "ok" }], details: { todos } },
        isError: false,
      };
    }

    it("takes checkpoint 0 after cloning, before Pi starts", async () => {
      const h = harness();
      await createAndRun(h);

      const list = h.manager.checkpoints();
      expect(list).toEqual([
        {
          id: 0,
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          createdAt: expect.any(String),
          reason: "start",
        },
      ]);
      const events = h.events.since(0).events.map((stored) => stored.event);
      expect(events).toContainEqual({ type: "checkpoint", action: "created", checkpoint: list[0] });
      expect(events.findIndex((event) => event.type === "checkpoint")).toBeLessThan(
        events.findIndex(isStatus("running")),
      );

      const ref = await realGit(["rev-parse", "refs/cna/checkpoints/0"], {
        cwd: h.workspaceDir,
      });
      expect(ref.stdout.trim()).toBe(list[0]?.commit);
    });

    it("takes a checkpoint when a run settles with changes, and none when nothing changed", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));

      await writeFile(join(h.workspaceDir, "README.md"), "changed\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));
      expect(h.events.since(0).events.map((stored) => stored.event)).toContainEqual({
        type: "checkpoint",
        action: "created",
        checkpoint: expect.objectContaining({ id: 1, reason: "run" }),
      });
      expect(pi.send).toHaveBeenCalledWith({ type: "get_fork_messages" });

      // postMessage waits for the queued checkpoint job: it is the barrier before the next settle.
      await h.manager.postMessage({ text: "again" });
      pi.emit({ type: "agent_settled" });
      await h.manager.postMessage({ text: "once more" });

      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
    });

    it("throws no_session without a session", async () => {
      const h = harness();
      expect(() => h.manager.checkpoints()).toThrow(SessionError);
      let caught: unknown;
      try {
        h.manager.checkpoints();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "no_session" });
      await expect(h.manager.restoreCheckpoint(0, { conversation: false })).rejects.toMatchObject({
        code: "no_session",
      });
      await expect(h.manager.diff()).rejects.toMatchObject({ code: "no_session" });
    });

    it("restores the files to a checkpoint and keeps the later checkpoints", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      await writeFile(join(h.workspaceDir, "README.md"), "changed\n");
      await writeFile(join(h.workspaceDir, "NEW.md"), "new\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      await writeFile(join(h.workspaceDir, "README.md"), "later\n");
      await writeFile(join(h.workspaceDir, "LATER.md"), "later\n");

      const response = await h.manager.restoreCheckpoint(0, { conversation: false });

      expect(response).toEqual({
        checkpoint: expect.objectContaining({ id: 0, reason: "start" }),
        conversationRestored: false,
      });
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("hello\n");
      expect(existsSync(join(h.workspaceDir, "NEW.md"))).toBe(false);
      expect(existsSync(join(h.workspaceDir, "LATER.md"))).toBe(false);
      expect(pi.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "fork" }));
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
      expect(h.events.since(0).events.map((stored) => stored.event)).toContainEqual({
        type: "checkpoint",
        action: "restored",
        checkpoint: expect.objectContaining({ id: 0 }),
      });
    });

    it("restores the conversation with fork, drops the later checkpoints and the task list of the checkpoint", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      const entries = forkMessages(["e1"]);
      pi.responders.set("get_fork_messages", () => ({ messages: entries }));
      pi.responders.set("fork", () => ({ text: "prompt e2", cancelled: false }));
      pi.emit(todoEnd("call-1", FIRST_TODOS));

      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      entries.push(...forkMessages(["e2"]));
      await h.manager.postMessage({ text: "second prompt" });
      pi.emit(todoEnd("call-2", SECOND_TODOS));
      await writeFile(join(h.workspaceDir, "README.md"), "two\n");
      await writeFile(join(h.workspaceDir, "NEW.md"), "new\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(2, "created"));

      const response = await h.manager.restoreCheckpoint(1, { conversation: true });

      expect(response).toEqual({
        checkpoint: expect.objectContaining({ id: 1 }),
        conversationRestored: true,
      });
      expect(pi.send).toHaveBeenCalledWith({ type: "fork", entryId: "e2" });
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
      const refs = await realGit(["for-each-ref", "--format=%(refname)", "refs/cna/checkpoints/"], {
        cwd: h.workspaceDir,
      });
      expect(refs.stdout.trim().split("\n")).toEqual([
        "refs/cna/checkpoints/0",
        "refs/cna/checkpoints/1",
      ]);
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("one\n");
      expect(existsSync(join(h.workspaceDir, "NEW.md"))).toBe(false);

      expect(h.manager.todos()).toEqual(FIRST_TODOS);
      const todoEvents = h.events
        .since(0)
        .events.map((stored) => stored.event)
        .filter((event) => event.type === "todo");
      expect(todoEvents.at(-1)).toEqual({ type: "todo", todos: FIRST_TODOS });
    });

    it("does not fork when the conversation is already at the checkpoint", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      const response = await h.manager.restoreCheckpoint(1, { conversation: true });

      expect(response.conversationRestored).toBe(true);
      expect(pi.send.mock.calls.map(([command]) => command.type)).not.toContain("fork");
    });

    it("refuses messages and another restore while a restore is in progress", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1", "e2"]) }));
      let releaseFork: () => void = () => undefined;
      pi.responders.set(
        "fork",
        () => new Promise((resolve) => (releaseFork = () => resolve({ cancelled: false }))),
      );

      const restoring = h.manager.restoreCheckpoint(0, { conversation: true });
      await vi.waitFor(() => {
        expect(pi.send.mock.calls.map(([command]) => command.type)).toContain("fork");
      });

      await expect(h.manager.postMessage({ text: "next" })).rejects.toMatchObject({
        code: "invalid_state",
      });
      await expect(h.manager.restoreCheckpoint(1, { conversation: false })).rejects.toMatchObject({
        code: "invalid_state",
      });

      releaseFork();
      await expect(restoring).resolves.toMatchObject({ conversationRestored: true });
      await expect(h.manager.postMessage({ text: "next" })).resolves.toEqual({
        disposition: "started",
      });
    });

    it("leaves the files alone when Pi cancels the fork", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      await writeFile(join(h.workspaceDir, "NEW.md"), "new\n");
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1", "e2"]) }));
      pi.responders.set("fork", () => ({ cancelled: true }));

      await expect(h.manager.restoreCheckpoint(0, { conversation: true })).rejects.toMatchObject({
        code: "invalid_state",
        message: "fork cancelled",
      });
      // The files are as they were before the call, not as checkpoint 0 (hello, no NEW.md).
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("one\n");
      expect(await readFile(join(h.workspaceDir, "NEW.md"), "utf8")).toBe("new\n");
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
    });

    it("puts the files back when the fork fails with a Pi error, keeping untracked files", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      // Created after checkpoint 1: restoring checkpoint 0 would delete it, a failed fork must not.
      await writeFile(join(h.workspaceDir, "NEW.md"), "new\n");
      await writeFile(join(h.workspaceDir, "README.md"), "later\n");
      pi.responders.set("fork", () => {
        throw new RpcCommandError("fork failed in Pi", "fork", "failed");
      });

      await expect(h.manager.restoreCheckpoint(0, { conversation: true })).rejects.toMatchObject({
        code: "invalid_state",
        message: "fork failed in Pi",
      });
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("later\n");
      expect(await readFile(join(h.workspaceDir, "NEW.md"), "utf8")).toBe("new\n");
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
      expect(h.manager.get()?.status).toBe("ready");
    });

    it("reports that the files could not be put back, and logs it, when the rollback also fails", async () => {
      // Counts only the checkout-index of the restore under test: the first one is the restore itself.
      let counting = false;
      let checkouts = 0;
      const h = harness((real) => async (args, options) => {
        if (counting && args[0] === "checkout-index") {
          checkouts += 1;
          if (checkouts === 2) {
            throw new Error("checkout-index broke");
          }
        }
        return real(args, options);
      });
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1", "e2"]) }));
      pi.responders.set("fork", () => ({ cancelled: true }));
      counting = true;

      await expect(h.manager.restoreCheckpoint(0, { conversation: true })).rejects.toMatchObject({
        code: "invalid_state",
        message: expect.stringMatching(
          /^fork cancelled; the files could not be put back: .*checkout-index broke$/,
        ),
      });
      expect(h.logs).toContainEqual(expect.stringContaining("could not be put back"));
      expect(checkouts).toBe(2);
    });

    it("puts the files back and does not fork when the file restore itself fails", async () => {
      let counting = false;
      let checkouts = 0;
      const h = harness((real) => async (args, options) => {
        if (counting && args[0] === "checkout-index") {
          checkouts += 1;
          if (checkouts === 1) {
            throw new GitError("git checkout-index failed", {
              args,
              exitCode: 128,
              stderr: "checkout-index broke",
            });
          }
        }
        return real(args, options);
      });
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1", "e2"]) }));
      await writeFile(join(h.workspaceDir, "NEW.md"), "new\n");
      counting = true;

      await expect(h.manager.restoreCheckpoint(0, { conversation: true })).rejects.toMatchObject({
        code: "invalid_state",
      });
      expect(pi.send.mock.calls.map(([command]) => command.type)).not.toContain("fork");
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("one\n");
      expect(await readFile(join(h.workspaceDir, "NEW.md"), "utf8")).toBe("new\n");
      expect(checkouts).toBe(2);
    });

    it("takes a safety snapshot, restores the files, then forks, in that order", async () => {
      const order: string[] = [];
      let recording = false;
      const h = harness((real) => async (args, options) => {
        if (recording && args[0] === "commit-tree" && args.includes("cna restore safety")) {
          order.push("safety snapshot");
        }
        if (recording && args[0] === "checkout-index") {
          order.push("restore files");
        }
        return real(args, options);
      });
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1", "e2"]) }));
      pi.responders.set("fork", () => {
        order.push("fork");
        return { cancelled: false };
      });
      const eventsBefore = eventTypes(h).length;
      recording = true;

      await h.manager.restoreCheckpoint(0, { conversation: true });

      expect(order).toEqual(["safety snapshot", "restore files", "fork"]);
      expect(pi.send).toHaveBeenCalledWith({ type: "fork", entryId: "e1" });
      // The safety snapshot is neither a checkpoint nor an event: only the restored event is new.
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0]);
      expect(eventTypes(h).slice(eventsBefore)).toEqual(["todo", "checkpoint"]);
      const refs = await realGit(["for-each-ref", "--format=%(refname)", "refs/cna/"], {
        cwd: h.workspaceDir,
      });
      expect(refs.stdout.trim().split("\n")).toEqual(["refs/cna/checkpoints/0"]);
    });

    it("refuses a conversation restore when the position of the checkpoint is unknown", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      // No responder for get_fork_messages: Pi gives no list, so the checkpoint has no position.
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      await expect(h.manager.restoreCheckpoint(1, { conversation: true })).rejects.toMatchObject({
        code: "invalid_state",
        message: "the conversation position of this checkpoint is unknown",
      });
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("one\n");
    });

    it("refuses a restore while the session is running, and an unknown checkpoint", async () => {
      const h = harness();
      const pi = await createAndRun(h);

      await expect(h.manager.restoreCheckpoint(0, { conversation: false })).rejects.toMatchObject({
        code: "invalid_state",
      });

      pi.emit({ type: "agent_settled" });
      await expect(h.manager.restoreCheckpoint(99, { conversation: false })).rejects.toMatchObject({
        code: "checkpoint_not_found",
      });
    });

    it("diffs the working tree against the base branch, with the status of each file", async () => {
      const h = harness();
      await createAndRun(h);
      await writeFile(join(h.workspaceDir, "README.md"), "changed\n");
      await writeFile(join(h.workspaceDir, "NEW.md"), "new\n");

      const diff = await h.manager.diff();

      const base = await realGit(["rev-parse", "HEAD"], { cwd: join(root, "source") });
      expect(diff.from).toEqual({ kind: "base", branch: "main", commit: base.stdout.trim() });
      expect(diff.files).toHaveLength(2);
      expect(diff.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            status: "modified",
            additions: 1,
            deletions: 1,
          }),
          expect.objectContaining({ path: "NEW.md", status: "added", additions: 1, deletions: 0 }),
        ]),
      );
      expect(diff.patch).toContain("+changed");
      expect(diff.truncated).toBe(false);
    });

    it("diffs against a checkpoint when one is given", async () => {
      const h = harness();
      await createAndRun(h);
      await writeFile(join(h.workspaceDir, "README.md"), "changed\n");

      const diff = await h.manager.diff(0);

      expect(diff.from).toEqual({
        kind: "checkpoint",
        id: 0,
        commit: h.manager.checkpoints()[0]?.commit,
      });
      expect(diff.files.map((file) => file.path)).toEqual(["README.md"]);
    });

    it("refuses a diff against an unknown checkpoint, and while the workspace is cloning", async () => {
      const h = harness();
      const creating = h.manager.create(REQUEST);

      await expect(h.manager.diff()).rejects.toMatchObject({ code: "invalid_state" });
      await creating;
      await waitForEvent(h.events, isStatus("running"));

      await expect(h.manager.diff(42)).rejects.toMatchObject({ code: "checkpoint_not_found" });
    });

    it("redacts secrets in the diff patch", async () => {
      const h = harness();
      await createAndRun(h);
      await writeFile(join(h.workspaceDir, "NOTES.md"), `token ${SECRET}\n`);

      const diff = await h.manager.diff();

      expect(diff.patch).not.toContain(SECRET);
      expect(diff.patch).toContain("+token [REDACTED]");
    });

    it("postMessage waits for the checkpoint being taken, so the next prompt is not counted in it", async () => {
      let slowSnapshot = false;
      let snapshotStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        snapshotStarted = resolve;
      });
      let releaseSnapshot!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      const h = harness((real) => async (args, options) => {
        if (slowSnapshot && args[0] === "write-tree") {
          snapshotStarted();
          await gate;
        }
        return real(args, options);
      });
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "changed\n");

      slowSnapshot = true;
      pi.emit({ type: "agent_settled" });
      await started;

      const posting = h.manager.postMessage({ text: "next" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pi.send).not.toHaveBeenCalledWith({ type: "prompt", message: "next" });

      releaseSnapshot();
      await expect(posting).resolves.toEqual({ disposition: "started" });
      expect(pi.send).toHaveBeenCalledWith({ type: "prompt", message: "next" });
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
    });

    it("keeps the session going, without a checkpoint 0, when the first snapshot fails", async () => {
      const h = harness((real) => async (args, options) => {
        if (args[0] === "commit-tree" && args.includes("cna checkpoint 0")) {
          throw new Error("disk full");
        }
        return real(args, options);
      });

      await createAndRun(h);

      expect(h.manager.get()?.status).toBe("running");
      expect(h.manager.checkpoints()).toEqual([]);
      expect(h.logs).toContainEqual(expect.stringContaining("checkpoint 0: disk full"));
    });

    it("takes no checkpoint for a run without changes right after its checkpoint", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.emit({ type: "agent_settled" });
      // postMessage waits for the queued checkpoint job: it is the barrier before the check.
      await h.manager.postMessage({ text: "again" });

      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0]);
    });

    it("compares a run with the restored files, not with the last checkpoint, after a files-only restore", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_fork_messages", () => ({ messages: forkMessages(["e1"]) }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));
      await writeFile(join(h.workspaceDir, "README.md"), "two\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(2, "created"));

      await h.manager.restoreCheckpoint(0, { conversation: false });
      expect(await readFile(join(h.workspaceDir, "README.md"), "utf8")).toBe("hello\n");

      // A run that changes nothing must not add a copy of checkpoint 0.
      pi.emit({ type: "agent_settled" });
      await h.manager.postMessage({ text: "nothing changed" });
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1, 2]);

      // A run that changes the files gets the next id after the last one.
      await writeFile(join(h.workspaceDir, "README.md"), "three\n");
      pi.emit({ type: "agent_settled" });
      await h.manager.postMessage({ text: "changed" });
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1, 2, 3]);
      expect(h.manager.checkpoints()[3]).toMatchObject({ id: 3, reason: "run" });
    });

    it("takes no checkpoint for a run without changes after a conversation restore", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      const entries = forkMessages(["e1"]);
      pi.responders.set("get_fork_messages", () => ({ messages: entries }));
      pi.responders.set("fork", () => ({ cancelled: false }));
      await writeFile(join(h.workspaceDir, "README.md"), "one\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(1, "created"));

      entries.push(...forkMessages(["e2"]));
      await h.manager.postMessage({ text: "second prompt" });
      await writeFile(join(h.workspaceDir, "README.md"), "two\n");
      pi.emit({ type: "agent_settled" });
      await waitForEvent(h.events, checkpointEvent(2, "created"));

      await h.manager.restoreCheckpoint(1, { conversation: true });
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);

      pi.emit({ type: "agent_settled" });
      await h.manager.postMessage({ text: "nothing changed" });
      expect(h.manager.checkpoints().map((checkpoint) => checkpoint.id)).toEqual([0, 1]);
    });
  });

  describe("push notifications", () => {
    function fakeNotifier(): { notify: ReturnType<typeof vi.fn> } & Notifier {
      return { notify: vi.fn(async (_notification: Notification) => undefined) };
    }

    it("notifies waiting_input with the question and the repo, and not again while questions wait", async () => {
      const notifier = fakeNotifier();
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);
      expect(notifier.notify).not.toHaveBeenCalled();

      pi.ui(selectRequest("q1", "cna:ask_user:Which one?", ["a", "b"]));
      expect(notifier.notify).toHaveBeenCalledTimes(1);
      expect(notifier.notify).toHaveBeenLastCalledWith({
        event: "waiting_input",
        title: "cna: octo/hello needs your input",
        message: "Which one?",
      });

      pi.ui(confirmRequest("q2", "cna:confirm:Push?"));
      expect(h.manager.get()?.status).toBe("waiting_input");
      expect(notifier.notify).toHaveBeenCalledTimes(1);
    });

    it("notifies ready with the branch when the run settles", async () => {
      const notifier = fakeNotifier();
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);

      pi.emit({ type: "agent_settled" });

      expect(h.manager.get()?.status).toBe("ready");
      expect(notifier.notify).toHaveBeenCalledTimes(1);
      expect(notifier.notify).toHaveBeenLastCalledWith({
        event: "ready",
        title: "cna: octo/hello finished",
        message: "Branch agent/fix-the-readme is ready.",
      });
    });

    it("notifies error with the reason when Pi exits unexpectedly", async () => {
      const notifier = fakeNotifier();
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);

      pi.exit(1, null);

      expect(notifier.notify).toHaveBeenCalledTimes(1);
      expect(notifier.notify).toHaveBeenLastCalledWith({
        event: "error",
        title: "cna: octo/hello failed",
        message: "pi exited unexpectedly (code 1, signal null)",
      });
    });

    it("does not notify when the clone ends and the run starts", async () => {
      const notifier = fakeNotifier();
      const h = harness(undefined, { notifier });
      await createAndRun(h);

      expect(h.manager.get()?.status).toBe("running");
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("redacts secrets from the notification text", async () => {
      const notifier = fakeNotifier();
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);

      pi.ui(selectRequest("q1", `cna:ask_user:Use ${SECRET} here?`, ["a"]));

      expect(notifier.notify).toHaveBeenCalledTimes(1);
      const sent = notifier.notify.mock.calls[0]?.[0] as Notification;
      expect(sent.message).toBe("Use [REDACTED] here?");
      expect(JSON.stringify(sent)).not.toContain(SECRET);
    });

    it("cuts the message to 300 characters", async () => {
      const notifier = fakeNotifier();
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);

      pi.ui(selectRequest("q1", `cna:ask_user:${"y".repeat(500)}`, ["a"]));

      const sent = notifier.notify.mock.calls[0]?.[0] as Notification;
      expect(sent.message).toBe("y".repeat(300));
    });

    it("keeps the session going and logs the error when notify rejects", async () => {
      const notifier: Notifier = {
        notify: vi.fn(async () => {
          throw new Error(`push failed with ${SECRET}`);
        }),
      };
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);

      pi.emit({ type: "agent_settled" });

      expect(h.manager.get()?.status).toBe("ready");
      expect(eventTypes(h)).toContain("status");
      await vi.waitFor(() =>
        expect(h.logs).toContain("notifications: push failed with [REDACTED]"),
      );
    });

    it("keeps the session going and logs the error when notify throws synchronously", async () => {
      const notifier: Notifier = {
        notify: vi.fn((): Promise<void> => {
          throw new Error("sync failure");
        }),
      };
      const h = harness(undefined, { notifier });
      const pi = await createAndRun(h);

      pi.ui(selectRequest("q1", "cna:ask_user:Which?", ["a"]));

      expect(h.manager.get()?.status).toBe("waiting_input");
      expect(h.manager.get()?.pendingQuestions.map((q) => q.id)).toEqual(["q1"]);
      expect(h.logs).toContain("notifications: sync failure");
      await h.manager.answer("q1", { value: "a" });
      expect(h.manager.get()?.status).toBe("running");
    });
  });

  describe("Pi lifecycle: idle suspension, restart and stats (ADR-0011 §1, §5, §8)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Moves a running session to `ready` with fake setTimeout/clearTimeout. The run leaves a file
     * change so it gets a checkpoint: its real git work ends (awaited without timers) before the
     * clock moves, otherwise the idle timer would wait for it.
     */
    async function settleWithFakeTimers(
      h: Harness,
      pi: FakePi,
      beforeSettled: () => void = () => undefined,
    ): Promise<void> {
      const checkpointsBefore = h.manager.checkpoints().length;
      await writeFile(join(h.workspaceDir, "NOTES.md"), `run ${checkpointsBefore}\n`);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      beforeSettled();
      pi.emit({ type: "agent_settled" });
      await waitForEvent(
        h.events,
        (event) =>
          event.type === "checkpoint" &&
          event.action === "created" &&
          event.checkpoint.id === checkpointsBefore,
      );
      // Lets the checkpoint job finish its bookkeeping (a macrotask runs after all microtasks).
      await new Promise((resolve) => setImmediate(resolve));
    }

    async function readyWithFakeTimers(h: Harness): Promise<FakePi> {
      // The clone and the start run with real timers; the clock is faked once the session is idle.
      vi.useRealTimers();
      const pi = await createAndRun(h);
      await settleWithFakeTimers(h, pi);
      return pi;
    }

    function commandSent(pi: FakePi, type: string): Record<string, unknown>[] {
      return pi.send.mock.calls
        .map((call) => call[0] as unknown as Record<string, unknown>)
        .filter((command) => command.type === type);
    }

    it("starts Pi with --session-id set to the session id", async () => {
      const h = harness();
      const pi = await createAndRun(h);

      const args = pi.spec.args;
      expect(args[args.indexOf("--session-id") + 1]).toBe(h.manager.get()?.id);
    });

    it("stops an idle ready session after idleTimeoutMs, without an error", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      const pi = await readyWithFakeTimers(h);

      await vi.advanceTimersByTimeAsync(999);
      expect(pi.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(pi.stop).toHaveBeenCalledOnce();
      expect(h.manager.get()).toMatchObject({ status: "ready", suspended: true });
      expect(h.manager.get()?.error).toBeUndefined();
      expect(h.events.since(0).events.map((stored) => stored.event)).not.toContainEqual(
        expect.objectContaining({ type: "status", status: "error" }),
      );
      expect(h.logs.some((line) => line.startsWith("pi suspended after "))).toBe(true);
    });

    it("does not suspend a run in progress", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      const pi = await createAndRun(h);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      pi.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "…" },
      });

      await vi.advanceTimersByTimeAsync(5000);

      expect(h.manager.get()?.status).toBe("running");
      expect(pi.stop).not.toHaveBeenCalled();
      expect(h.manager.get()?.suspended).toBe(false);
    });

    it("does not suspend while a question is pending", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      const pi = await readyWithFakeTimers(h);
      pi.ui(confirmRequest("q1", "cna:confirm:Push?"));
      expect(h.manager.get()?.status).toBe("waiting_input");

      await vi.advanceTimersByTimeAsync(5000);

      expect(pi.stop).not.toHaveBeenCalled();
      expect(h.manager.get()?.suspended).toBe(false);
    });

    it("never suspends when idleTimeoutMs is 0 or absent", async () => {
      for (const options of [{ idleTimeoutMs: 0 }, {}]) {
        const h = harness(undefined, options);
        const pi = await readyWithFakeTimers(h);

        await vi.advanceTimersByTimeAsync(60 * 60_000);

        expect(pi.stop).not.toHaveBeenCalled();
        expect(h.manager.get()?.suspended).toBe(false);
      }
    });

    it("restarts the idle timer with every activity", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      const pi = await readyWithFakeTimers(h);

      await vi.advanceTimersByTimeAsync(900);
      h.manager.todos();
      await vi.advanceTimersByTimeAsync(100);
      expect(pi.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(900);
      expect(pi.stop).toHaveBeenCalledOnce();
    });

    it("starts a new Pi with the same session id on postMessage, without streamingBehavior", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      await readyWithFakeTimers(h);
      const id = h.manager.get()?.id;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.manager.get()?.suspended).toBe(true);

      await h.manager.postMessage({ text: "again" });

      expect(h.startPi).toHaveBeenCalledTimes(2);
      const args = onlyPi(h).spec.args;
      expect(args[args.indexOf("--session-id") + 1]).toBe(id);
      expect(h.manager.get()?.suspended).toBe(false);
      expect(commandSent(onlyPi(h), "prompt")).toEqual([{ type: "prompt", message: "again" }]);
      expect(onlyPi(h).send.mock.calls[0]?.[0]).not.toHaveProperty("streamingBehavior");
    });

    it("starts Pi again for messages(), stats() and setModel()", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      await readyWithFakeTimers(h);
      await vi.advanceTimersByTimeAsync(1000);

      await h.manager.messages();
      expect(h.startPi).toHaveBeenCalledTimes(2);
      expect(h.manager.get()?.suspended).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect(h.manager.get()?.suspended).toBe(true);
      // The new Pi is created by the call itself: its responder is set before Pi is asked.
      const statsCall = h.manager.stats();
      onlyPi(h).responders.set("get_session_stats", () => ({
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: 0,
      }));
      await statsCall;
      expect(h.startPi).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1000);
      expect(h.manager.get()?.suspended).toBe(true);
      await h.manager.setModel({ model: "ollama/qwen3-coder:30b" });
      expect(h.startPi).toHaveBeenCalledTimes(4);
      expect(onlyPi(h).send).toHaveBeenCalledWith({
        type: "set_model",
        provider: "ollama",
        modelId: "qwen3-coder:30b",
      });
    });

    it("starts a single Pi for concurrent calls after a suspension", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      await readyWithFakeTimers(h);
      await vi.advanceTimersByTimeAsync(1000);

      await Promise.all([h.manager.messages(), h.manager.messages()]);

      expect(h.startPi).toHaveBeenCalledTimes(2);
      expect(h.manager.get()?.suspended).toBe(false);
    });

    it("does not start Pi for abort() after a suspension", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      await readyWithFakeTimers(h);
      await vi.advanceTimersByTimeAsync(1000);

      await h.manager.abort();

      expect(h.startPi).toHaveBeenCalledTimes(1);
      expect(h.manager.get()?.suspended).toBe(true);
    });

    it("does not pass --cna-plan to a restarted Pi once the plan is approved", async () => {
      const h = harness(undefined, { idleTimeoutMs: 1000 });
      const pi = await createAndRun(h, { ...REQUEST, mode: "plan" });
      expect(pi.spec.args).toContain("--cna-plan");
      await settleWithFakeTimers(h, pi, () =>
        pi.emit({
          type: "entry_appended",
          entry: { type: "custom", customType: "cna.mode", data: { mode: "auto" } },
        }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(pi.stop).toHaveBeenCalledOnce();

      await h.manager.postMessage({ text: "implement it" });

      expect(h.startPi).toHaveBeenCalledTimes(2);
      expect(onlyPi(h).spec.args).not.toContain("--cna-plan");
      expect(h.manager.get()?.mode).toBe("auto");
    });

    it("stops the idle timer on close() and on shutdown()", async () => {
      const closed = harness(undefined, { idleTimeoutMs: 1000 });
      const closedPi = await readyWithFakeTimers(closed);
      await closed.manager.close({ force: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(closedPi.stop).toHaveBeenCalledOnce();
      expect(closed.manager.get()).toBeNull();

      const shut = harness(undefined, { idleTimeoutMs: 1000 });
      const shutPi = await readyWithFakeTimers(shut);
      await shut.manager.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      expect(shutPi.stop).toHaveBeenCalledOnce();
      expect(shut.logs.some((line) => line.startsWith("pi suspended"))).toBe(false);
    });

    it("translates the stats of Pi (get_session_stats)", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_session_stats", () => ({
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126 },
        cost: 0.0123,
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 4,
        contextUsage: { contextWindow: 32000, tokens: 1200, percent: 3.75 },
      }));

      expect(await h.manager.stats()).toEqual({
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126 },
        cost: 0.0123,
        messages: { user: 2, assistant: 3, toolCalls: 4 },
        context: { tokens: 1200, window: 32000, percent: 3.75 },
      });
      expect(pi.send).toHaveBeenCalledWith({ type: "get_session_stats" });
    });

    it("throws no_session for stats() without a session", async () => {
      const h = harness();
      await expect(h.manager.stats()).rejects.toMatchObject({ code: "no_session" });
    });

    it("throws invalid_state for stats() while cloning", async () => {
      const h = harness();
      await h.manager.create(REQUEST);

      await expect(h.manager.stats()).rejects.toMatchObject({ code: "invalid_state" });
    });

    it("throws invalid_state when Pi answers stats() without stats", async () => {
      const h = harness();
      const pi = await createAndRun(h);
      pi.responders.set("get_session_stats", () => ({}));

      await expect(h.manager.stats()).rejects.toMatchObject({
        code: "invalid_state",
        message: "Pi did not return session stats",
      });
    });
  });
});
