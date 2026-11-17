import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionEvent, StreamEvent } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/events/event-log.js";
import type { PiLaunchSpec } from "../src/pi/launch.js";
import { createRedactor } from "../src/redact.js";
import type { RpcBridgeHandlers, RpcCommandInput, RpcEvent } from "../src/rpc/bridge.js";
import { type PiProcess, prPrompt, SessionManager } from "../src/session/manager.js";
import { SessionError } from "../src/session/service.js";
import { createGitRunner } from "../src/workspace/git.js";
import type { GhRunner, PullRequestInfo } from "../src/workspace/pr.js";

const SECRET = "ghp_supersecret123";
const PR_VIEW_FIELDS = "number,state,isCrossRepository,headRefName,baseRefName";

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
  root = await mkdtemp(join(tmpdir(), "cna-session-pr-"));

  // Source repo: main, and the agent branch agent/fix with one commit. Bare clone as the remote octo/hello.
  const source = join(root, "source");
  await mkdir(source);
  await realGit(["init", "--initial-branch=main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await realGit(["add", "README.md"], { cwd: source });
  await realGit(["commit", "-m", "initial"], { cwd: source });
  await realGit(["checkout", "-b", "agent/fix"], { cwd: source });
  await writeFile(join(source, "fix.txt"), "fix\n");
  await realGit(["add", "fix.txt"], { cwd: source });
  await realGit(["commit", "-m", "fix"], { cwd: source });
  await realGit(["checkout", "main"], { cwd: source });

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

/** A gh that answers `gh pr view` with the given JSON (or fails with the given error), and records the calls. */
interface GhCall {
  args: string[];
  cwd: string;
}

function fakeGh(view: Record<string, unknown>, failure?: Error): { gh: GhRunner; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: GhRunner = async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    if (failure !== undefined) {
      throw failure;
    }
    return { stdout: JSON.stringify(view), stderr: "" };
  };
  return { gh, calls };
}

const OPEN_AGENT_PR = {
  number: 12,
  state: "OPEN",
  isCrossRepository: false,
  headRefName: "agent/fix",
  baseRefName: "main",
};

/** Fake Pi: records the handlers so tests can emit events, answers commands by type. */
class FakePi implements PiProcess {
  readonly send = vi.fn(async (command: RpcCommandInput, _options?: { timeoutMs?: number }) => {
    if (command.type === "prompt") {
      return { disposition: "started" };
    }
    return undefined;
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
}

interface Harness {
  manager: SessionManager;
  events: EventLog;
  pis: FakePi[];
  startPi: ReturnType<typeof vi.fn>;
  workspaceDir: string;
  gh: { calls: GhCall[] } | undefined;
}

interface HarnessOptions {
  /** Answers of gh; default: an open PR of agent/fix into main. */
  view?: Record<string, unknown>;
  /** gh fails with this error instead. */
  failure?: Error;
  /** The manager has no gh (the runtime without gh). */
  withoutGh?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const events = new EventLog();
  const pis: FakePi[] = [];
  const startPi = vi.fn((spec: PiLaunchSpec, handlers: RpcBridgeHandlers): PiProcess => {
    const pi = new FakePi(handlers, spec);
    pis.push(pi);
    return pi;
  });
  const workspaceDir = join(root, "data", "workspace", "repo");
  const fake =
    options.withoutGh === true ? undefined : fakeGh(options.view ?? OPEN_AGENT_PR, options.failure);
  const logs: string[] = [];
  const manager = new SessionManager({
    events,
    redactor: createRedactor([SECRET]),
    git: realGit,
    startPi,
    workspaceDir,
    gh: fake?.gh,
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
    pis,
    startPi,
    workspaceDir,
    gh: fake,
  };
  harnesses.push(created);
  return created;
}

function onlyPi(h: Harness): FakePi {
  const pi = h.pis.at(-1);
  if (pi === undefined) {
    throw new Error("no Pi was started");
  }
  return pi;
}

/** Resolves with the first stored event matching the predicate (replayed from the buffer, then live). */
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

/** The code of the SessionError thrown by a promise, or undefined if it resolves. */
async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SessionError ? error.code : `not a SessionError: ${String(error)}`;
  }
}

/** The prompts sent to Pi, in order. */
function promptsOf(pi: FakePi): string[] {
  return pi.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is { type: "prompt"; message: string } => command.type === "prompt")
    .map((command) => command.message);
}

const PR_12: PullRequestInfo = { number: 12, headBranch: "agent/fix", baseBranch: "main" };

describe("SessionManager on a pull request (feature 7, ADR-0011 §9)", () => {
  it("works on the head branch of the PR with its base and asks Pi to address the review", async () => {
    const h = harness();

    const created = await h.manager.create({ repo: "octo/hello", pr: 12 });

    expect(created).toMatchObject({ pr: 12, baseBranch: null, branch: null, status: "cloning" });
    await waitForEvent(h.events, isStatus("running"));
    expect(h.manager.get()).toMatchObject({
      pr: 12,
      branch: "agent/fix",
      baseBranch: "main",
    });

    const head = await realGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: h.workspaceDir });
    expect(head.stdout.trim()).toBe("agent/fix");
    const remoteHead = await realGit(["rev-parse", "agent/fix"], {
      cwd: join(root, "remote", "octo", "hello.git"),
    });
    const localHead = await realGit(["rev-parse", "HEAD"], { cwd: h.workspaceDir });
    expect(localHead.stdout).toBe(remoteHead.stdout);
    expect(await readFile(join(h.workspaceDir, "fix.txt"), "utf8")).toBe("fix\n");

    const args = onlyPi(h).spec.args;
    expect(args[args.indexOf("--cna-base-branch") + 1]).toBe("main");

    expect(promptsOf(onlyPi(h))).toEqual([prPrompt("octo/hello", PR_12)]);
    expect(prPrompt("octo/hello", PR_12)).toContain("#12");

    onlyPi(h).emit({ type: "agent_settled" });
    await waitForEvent(h.events, isStatus("ready"));
    expect(h.manager.get()?.status).toBe("ready");
  });

  it("runs gh with the exact arguments, from the parent of the workspace", async () => {
    const h = harness();

    await h.manager.create({ repo: "octo/hello", pr: 12 });
    await waitForEvent(h.events, isStatus("running"));

    expect(h.gh?.calls).toEqual([
      {
        args: ["pr", "view", "12", "--repo", "octo/hello", "--json", PR_VIEW_FIELDS],
        cwd: join(root, "data", "workspace"),
      },
    ]);
  });

  it("appends the instructions of the user to the first prompt", async () => {
    const h = harness();

    await h.manager.create({
      repo: "octo/hello",
      pr: 12,
      prompt: "también actualiza el changelog",
    });
    await waitForEvent(h.events, isStatus("running"));

    const [message] = promptsOf(onlyPi(h));
    expect(message).toBe(prPrompt("octo/hello", PR_12, "también actualiza el changelog"));
    expect(
      message?.endsWith("Additional instructions from the user:\ntambién actualiza el changelog"),
    ).toBe(true);
  });

  it("ignores the requested baseBranch: the base is the one of the PR", async () => {
    const h = harness();

    const created = await h.manager.create({
      repo: "octo/hello",
      pr: 12,
      baseBranch: "otra",
    });
    expect(created.baseBranch).toBeNull();
    await waitForEvent(h.events, isStatus("running"));

    expect(h.manager.get()).toMatchObject({ baseBranch: "main", branch: "agent/fix" });
    const args = onlyPi(h).spec.args;
    expect(args[args.indexOf("--cna-base-branch") + 1]).toBe("main");
  });

  it("fails with status error and never starts Pi when the PR is closed", async () => {
    const h = harness({ view: { ...OPEN_AGENT_PR, state: "CLOSED" } });

    await h.manager.create({ repo: "octo/hello", pr: 12 });
    const stored = await waitForEvent(h.events, isStatus("error"));

    expect(stored.event).toEqual({
      type: "status",
      status: "error",
      error: "pull request #12 is closed",
    });
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("fails with status error when the head branch is not an agent/* branch", async () => {
    const h = harness({ view: { ...OPEN_AGENT_PR, headRefName: "feature/x" } });

    await h.manager.create({ repo: "octo/hello", pr: 12 });
    const stored = await waitForEvent(h.events, isStatus("error"));

    expect(stored.event).toEqual({
      type: "status",
      status: "error",
      error: "pull request #12 is not from an agent/* branch",
    });
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("fails with status error when gh rejects the PR", async () => {
    const h = harness({
      failure: new Error("gh pr failed: GraphQL: Could not resolve to a PullRequest"),
    });

    await h.manager.create({ repo: "octo/hello", pr: 12 });
    const stored = await waitForEvent(h.events, isStatus("error"));

    expect(stored.event).toMatchObject({ type: "status", status: "error" });
    expect(h.manager.get()?.error).toContain("not found or not accessible");
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("refuses pr when the runtime has no gh", async () => {
    const h = harness({ withoutGh: true });

    expect(await errorCodeOf(h.manager.create({ repo: "octo/hello", pr: 12 }))).toBe(
      "invalid_request",
    );
    expect(h.manager.get()).toBeNull();
    expect(h.startPi).not.toHaveBeenCalled();
  });

  it("refuses a request with neither prompt nor pr", async () => {
    const h = harness();

    expect(await errorCodeOf(h.manager.create({ repo: "octo/hello" }))).toBe("invalid_request");
    expect(h.manager.get()).toBeNull();
  });

  it("never shows a secret of gh in the status event", async () => {
    const h = harness({
      failure: new Error(`gh pr failed: token ${SECRET} was rejected`),
    });

    await h.manager.create({ repo: "octo/hello", pr: 12 });
    const stored = await waitForEvent(h.events, isStatus("error"));

    expect(JSON.stringify(stored.event)).not.toContain(SECRET);
    expect(h.manager.get()?.error).not.toContain(SECRET);
  });
});

describe("prPrompt", () => {
  it("asks to address the review of the PR when the user gives no prompt", () => {
    expect(prPrompt("octo/hello", PR_12)).toBe(
      "You are working on pull request #12 of octo/hello (branch agent/fix, base main). " +
        "Read its description and review comments with gh: `gh pr view 12 --repo octo/hello --comments` " +
        "and `gh api repos/octo/hello/pulls/12/comments`. " +
        "Address each comment that asks for a change, commit with git_commit and push to the same branch with git_push. " +
        "Do not open a new pull request. " +
        "When you are done, summarise what you changed for each review comment.",
    );
  });

  it("appends the user's prompt after two line breaks", () => {
    const base = prPrompt("octo/hello", PR_12);

    expect(prPrompt("octo/hello", PR_12, "haz X")).toBe(
      `${base}\n\nAdditional instructions from the user:\nhaz X`,
    );
  });
});
