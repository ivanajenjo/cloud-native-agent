import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessagesResponse, Question, SessionInfo } from "@cna/shared";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GatewayConfig, loadGatewayConfig } from "../src/config.js";
import { createGatewayRuntime, type GatewayRuntime } from "../src/wiring.js";
import { createGitRunner } from "../src/workspace/git.js";
import { type MockOpenAI, type ScriptedTurn, startMockOpenAI } from "./support/mock-openai.js";

/** Fake token: must never appear in responses, events or the repository. */
const GITHUB_TOKEN = "ghp_e2e_secret_token_value";
const PROMPT = "Create the file I choose";
const BRANCH_PREFIX = "agent/";
const FINAL_TEXT = "Done: created b.txt and pushed the branch.";
const FILE_CONTENT = "hello from e2e\n";
const MODEL = "mock-model";

/** Variables that route traffic through a proxy; the mock is local, so they must not apply. */
const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "NODE_USE_ENV_PROXY",
];

/** The model's script: ask, write, commit, push, then answer. */
const SCRIPT: ScriptedTurn[] = [
  {
    toolCalls: [
      {
        name: "ask_user",
        arguments: { question: "Which file should I create?", options: ["a.txt", "b.txt"] },
      },
    ],
  },
  {
    toolCalls: [{ name: "write", arguments: { path: "b.txt", content: FILE_CONTENT } }],
  },
  { toolCalls: [{ name: "git_commit", arguments: { message: "Add b.txt" } }] },
  { toolCalls: [{ name: "git_push", arguments: {} }] },
  { text: FINAL_TEXT },
];

/** Git isolated from the machine's configuration. */
const GIT_ENV: Record<string, string | undefined> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "E2E Agent",
  GIT_AUTHOR_EMAIL: "agent@e2e.invalid",
  GIT_COMMITTER_NAME: "E2E Agent",
  GIT_COMMITTER_EMAIL: "agent@e2e.invalid",
};

const realGit = createGitRunner(GIT_ENV);
const extensionsDir = loadGatewayConfig({}).extensionsDir;

/** Everything the test needs, created in beforeAll and released in afterAll. */
interface Fixture {
  root: string;
  bareRepo: string;
  mock: MockOpenAI;
  runtime: GatewayRuntime;
  app: Hono;
}

let fixture: Fixture | undefined;
/** Last console lines of the gateway (Pi's stderr and logger output), for diagnostics. */
const gatewayLog: string[] = [];
let consoleSpies: Array<{ mockRestore(): void }> = [];

function recordLine(args: unknown[]): void {
  gatewayLog.push(args.map(String).join(" "));
  if (gatewayLog.length > 200) {
    gatewayLog.shift();
  }
}

/** Env of the runtime: the host's proxies removed, git isolated, a fake GitHub token. */
function e2eEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const variable of PROXY_VARIABLES) {
    delete env[variable];
  }
  return {
    ...env,
    ...GIT_ENV,
    NO_PROXY: "127.0.0.1,localhost",
    HOME: home,
    GITHUB_TOKEN,
  };
}

function requireFixture(): Fixture {
  if (fixture === undefined) {
    throw new Error("e2e fixture is not ready (beforeAll failed?)");
  }
  return fixture;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSession(app: Hono): Promise<SessionInfo> {
  const response = await app.request("/session");
  expect(response.status).toBe(200);
  return (await response.json()) as SessionInfo;
}

/** Polls `GET /session` until `probe` returns a value. Fails fast if the session is in error. */
async function waitFor<T>(
  label: string,
  app: Hono,
  probe: (info: SessionInfo) => T | undefined,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let info: SessionInfo | undefined;
  while (Date.now() < deadline) {
    info = await getSession(app);
    if (info.status === "error") {
      throw new Error(
        `session failed while waiting for ${label}: ${info.error ?? "unknown error"}\n` +
          `last gateway output:\n${gatewayLog.slice(-30).join("\n")}`,
      );
    }
    const value = probe(info);
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(
    `timeout waiting for ${label}; status=${info?.status ?? "none"}\n` +
      `last gateway output:\n${gatewayLog.slice(-30).join("\n")}`,
  );
}

/**
 * Reads the SSE replay of the current session. The stream never ends by itself, so reading
 * stops after `idleMs` without new data.
 */
async function readEventReplay(app: Hono, idleMs = 500): Promise<string> {
  const controller = new AbortController();
  const response = await app.request("/session/events", { signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("events stream has no body");
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), sleep(idleMs).then(() => undefined)]);
      if (next === undefined || next.done) {
        break;
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

describe("e2e: real Pi in RPC mode against a mock OpenAI endpoint", () => {
  beforeAll(async () => {
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => recordLine(args)),
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => recordLine(args)),
    ];

    const root = await mkdtemp(join(tmpdir(), "cna-e2e-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });

    // Source repo with README.md on main, then a bare clone as the "remote" octo/hello.
    const source = join(root, "source");
    await mkdir(source);
    await realGit(["init", "--initial-branch=main"], { cwd: source });
    await writeFile(join(source, "README.md"), "hello\n");
    await realGit(["add", "README.md"], { cwd: source });
    await realGit(["commit", "-m", "initial"], { cwd: source });

    await mkdir(join(root, "remote", "octo"), { recursive: true });
    const bareRepo = join(root, "remote", "octo", "hello.git");
    await realGit(["clone", "--bare", source, bareRepo], { cwd: root });
    const remoteBase = `${pathToFileURL(join(root, "remote")).href}/`;

    const mock = await startMockOpenAI(MODEL, SCRIPT);
    const providersFile = join(root, "providers.yaml");
    await writeFile(
      providersFile,
      [
        "default: mock/mock-model",
        "providers:",
        "  mock:",
        `    baseUrl: ${mock.url}`,
        "    api: openai-completions",
        "    models:",
        `      - id: ${MODEL}`,
        "        contextWindow: 32000",
        "",
      ].join("\n"),
    );

    const config: GatewayConfig = {
      port: 0,
      dataDir: join(root, "data"),
      providersFile,
      notificationsFile: join(root, "notifications.yaml"),
      webFile: join(root, "web.yaml"),
      extensionsDir,
      gitUserName: "E2E Agent",
      gitUserEmail: "agent@e2e.invalid",
    };
    const runtime = await createGatewayRuntime({
      config,
      version: "e2e",
      env: e2eEnv(home),
      remoteBase,
    });

    fixture = { root, bareRepo, mock, runtime, app: runtime.app as Hono };
  }, 60_000);

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.runtime.close();
      await fixture.mock.close();
      await rm(fixture.root, { recursive: true, force: true });
      fixture = undefined;
    }
    for (const spy of consoleSpies) {
      spy.mockRestore();
    }
  }, 60_000);

  it("clones, asks the user, commits and pushes the agent branch after confirmation", async () => {
    const { app, mock, bareRepo, root } = requireFixture();

    // Session creation.
    const created = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "octo/hello", prompt: PROMPT }),
    });
    expect(created.status).toBe(201);

    // First question: the ask_user dialog with its options.
    const askQuestion = await waitFor("ask_user question", app, (info) =>
      info.pendingQuestions.find((question) => question.kind === "ask_user"),
    );
    expect(askQuestion.method).toBe("select");
    expect(askQuestion.options).toStrictEqual(["a.txt", "b.txt"]);
    expect((await getSession(app)).status).toBe("waiting_input");

    const answered = await app.request(`/session/answers/${encodeURIComponent(askQuestion.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "b.txt" }),
    });
    expect(answered.status).toBe(204);

    // Second question: the confirmation of git_push.
    const confirmQuestion: Question = await waitFor("confirm question", app, (info) =>
      info.pendingQuestions.find((question) => question.kind === "confirm"),
    );
    expect(confirmQuestion.method).toBe("confirm");

    const confirmed = await app.request(
      `/session/answers/${encodeURIComponent(confirmQuestion.id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      },
    );
    expect(confirmed.status).toBe(204);

    const ready = await waitFor("ready status", app, (info) =>
      info.status === "ready" ? info : undefined,
    );
    expect(ready.pendingQuestions).toStrictEqual([]);
    expect(ready.branch).toMatch(/^agent\/[a-z0-9-]+$/);
    const branch = ready.branch as string;

    // The bare remote has the agent branch with the file and the commit.
    const remoteGit = (args: string[]) => realGit(["--git-dir", bareRepo, ...args], { cwd: root });
    const branches = await remoteGit(["branch", "--list", `${BRANCH_PREFIX}*`]);
    const branchNames = branches.stdout
      .split("\n")
      .map((line) => line.replace(/^\*?\s+/, "").trim());
    expect(branchNames).toContain(branch);
    const file = await remoteGit(["show", `${branch}:b.txt`]);
    expect(file.stdout).toBe(FILE_CONTENT);
    const subject = await remoteGit(["log", "-1", "--format=%s", branch]);
    expect(subject.stdout.trim()).toBe("Add b.txt");

    // Messages of the session include Pi's final answer.
    const messagesResponse = await app.request("/session/messages");
    expect(messagesResponse.status).toBe(200);
    const messagesText = await messagesResponse.text();
    const body = JSON.parse(messagesText) as MessagesResponse;
    const assistantMessages = body.messages.filter((message) => message.role === "assistant");
    expect(JSON.stringify(assistantMessages)).toContain(FINAL_TEXT);

    // The token never leaks into session info, messages or the events.
    expect(JSON.stringify(ready)).not.toContain(GITHUB_TOKEN);
    expect(messagesText).not.toContain(GITHUB_TOKEN);
    const events = await readEventReplay(app);
    expect(events).toContain('"type":"question"');
    expect(events).not.toContain(GITHUB_TOKEN);

    // The mock saw the whole conversation, and its first request offers our tools.
    expect(mock.requests.length).toBeGreaterThanOrEqual(5);
    const firstRequest = mock.requests[0] as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const toolNames = (firstRequest.tools ?? []).map((tool) => tool.function?.name);
    expect(toolNames).toEqual(expect.arrayContaining(["ask_user", "git_commit", "git_push"]));

    // Everything is pushed, so the session can be closed.
    const deleted = await app.request("/session", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const gone = await app.request("/session");
    expect(gone.status).toBe(404);
  }, 120_000);
});
