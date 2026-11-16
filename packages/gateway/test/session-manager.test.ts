import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CreateSessionRequest, Question, SessionEvent, StreamEvent } from "@cna/shared";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/events/event-log.js";
import type { ToolLog } from "../src/logs/tool-log.js";
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
import { createGitRunner, type GitRunner } from "../src/workspace/git.js";

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
});
