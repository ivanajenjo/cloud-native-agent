import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessagesResponse, PiMessage, SessionInfo, StreamEvent } from "@cna/shared";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GatewayConfig, loadGatewayConfig } from "../src/config.js";
import { createGatewayRuntime, type GatewayRuntime } from "../src/wiring.js";
import { createGitRunner } from "../src/workspace/git.js";
import { type MockOpenAI, type ScriptedTurn, startMockOpenAI } from "./support/mock-openai.js";

const PROMPT = "Who are you?";
const FIRST_ANSWER = "Hola, soy el agente.";
const SECOND_PROMPT = "Are you still there?";
const SECOND_ANSWER = "Sigo aquí, y recuerdo la conversación.";
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

/** One text answer per run: the first run, then the run after the restart. No tools. */
const SCRIPT: ScriptedTurn[] = [{ text: FIRST_ANSWER }, { text: SECOND_ANSWER }];

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

/** Created in beforeAll, released in afterAll. */
let root: string | undefined;
let mock: MockOpenAI | undefined;
let config: GatewayConfig | undefined;
let env: Record<string, string | undefined> | undefined;
let remoteBase: string | undefined;
/** The gateway runtime that is up now: the first one, then the one started after the restart. */
let current: GatewayRuntime | undefined;

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
  const copy: Record<string, string | undefined> = { ...process.env };
  for (const variable of PROXY_VARIABLES) {
    delete copy[variable];
  }
  return {
    ...copy,
    ...GIT_ENV,
    NO_PROXY: "127.0.0.1,localhost",
    HOME: home,
  };
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`e2e restart fixture is not ready: ${name} (beforeAll failed?)`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts a gateway runtime on the same config: the same dataDir means the same saved state. */
async function startGateway(): Promise<GatewayRuntime> {
  const runtime = await createGatewayRuntime({
    config: requireValue(config, "config"),
    version: "e2e",
    env: requireValue(env, "env"),
    remoteBase: requireValue(remoteBase, "remoteBase"),
  });
  current = runtime;
  return runtime;
}

async function getSession(app: Hono): Promise<SessionInfo> {
  const response = await app.request("/session");
  expect(response.status).toBe(200);
  return (await response.json()) as SessionInfo;
}

async function getMessages(app: Hono): Promise<PiMessage[]> {
  const response = await app.request("/session/messages");
  expect(response.status).toBe(200);
  const body = (await response.json()) as MessagesResponse;
  return body.messages;
}

/** Polls `GET /session` until `probe` returns a value. Fails fast if the session is in error. */
async function waitFor<T>(
  label: string,
  app: Hono,
  probe: (info: SessionInfo) => T | undefined,
  timeoutMs = 60_000,
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

/** Waits until the session is `ready` and holds `count` messages (the run's reply is the last one). */
async function waitForMessageCount(app: Hono, count: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = -1;
  while (Date.now() < deadline) {
    const info = await getSession(app);
    if (info.status === "error") {
      throw new Error(`session failed: ${info.error ?? "unknown error"}`);
    }
    if (info.status === "ready") {
      seen = summarize(await getMessages(app)).length;
      if (seen === count) {
        return;
      }
    }
    await sleep(100);
  }
  throw new Error(
    `timeout waiting for ${count} messages; last count=${seen}\n` +
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

/** The messages of the last `history` event in an SSE replay, or undefined if there is none. */
function historyOf(replay: string): PiMessage[] | undefined {
  let messages: PiMessage[] | undefined;
  for (const record of replay.split("\n\n")) {
    const dataLine = record.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) {
      continue;
    }
    const streamEvent = JSON.parse(dataLine.slice("data: ".length)) as StreamEvent;
    if (streamEvent.event.type === "history") {
      messages = streamEvent.event.messages;
    }
  }
  return messages;
}

/** Waits until the SSE replay holds a `history` event. Pi answers get_messages before it is sent. */
async function waitForHistory(app: Hono, timeoutMs = 60_000): Promise<PiMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = historyOf(await readEventReplay(app));
    if (messages !== undefined) {
      return messages;
    }
    await sleep(200);
  }
  throw new Error(
    `timeout waiting for a history event\nlast gateway output:\n${gatewayLog.slice(-30).join("\n")}`,
  );
}

/**
 * Role and plain text of each message of the conversation, so two lists can be compared without
 * Pi's extra fields. Pi's get_messages also lists a `system` message (the system prompt in sections,
 * with empty content): it is not part of the conversation, so it is left out.
 */
function summarize(messages: PiMessage[]): Array<{ role: string; text: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, text: textOf(message.content) }));
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

describe("e2e restart: the conversation survives a gateway restart (ADR-0011 §1 and §3)", () => {
  beforeAll(async () => {
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => recordLine(args)),
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => recordLine(args)),
    ];

    const dir = await mkdtemp(join(tmpdir(), "cna-e2e-restart-"));
    root = dir;
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });

    // Source repo with README.md on main, then a bare clone as the "remote" octo/hello.
    const source = join(dir, "source");
    await mkdir(source);
    await realGit(["init", "--initial-branch=main"], { cwd: source });
    await writeFile(join(source, "README.md"), "hello\n");
    await realGit(["add", "README.md"], { cwd: source });
    await realGit(["commit", "-m", "initial"], { cwd: source });

    await mkdir(join(dir, "remote", "octo"), { recursive: true });
    const bareRepo = join(dir, "remote", "octo", "hello.git");
    await realGit(["clone", "--bare", source, bareRepo], { cwd: dir });
    remoteBase = `${pathToFileURL(join(dir, "remote")).href}/`;

    mock = await startMockOpenAI(MODEL, SCRIPT);
    const providersFile = join(dir, "providers.yaml");
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

    // Both runtimes get this same config: the same dataDir is what makes the restart resume.
    config = {
      port: 0,
      dataDir: join(dir, "data"),
      providersFile,
      notificationsFile: join(dir, "notifications.yaml"),
      webFile: join(dir, "web.yaml"),
      extensionsDir,
      webUiDir: join(dir, "web-ui"),
      gitUserName: "E2E Agent",
      gitUserEmail: "agent@e2e.invalid",
      idleTimeoutMs: 1_800_000,
    };
    env = e2eEnv(home);
  }, 60_000);

  afterAll(async () => {
    if (current !== undefined) {
      await current.close();
      current = undefined;
    }
    if (mock !== undefined) {
      await mock.close();
      mock = undefined;
    }
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
      root = undefined;
    }
    for (const spy of consoleSpies) {
      spy.mockRestore();
    }
  }, 60_000);

  it("reopens the conversation in a new Pi with the same session id after a restart", async () => {
    // Run A: one prompt, one text answer. The session is `ready` once the run has settled.
    const runtimeA = await startGateway();
    const appA = runtimeA.app;
    const created = await appA.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "octo/hello", prompt: PROMPT }),
    });
    expect(created.status).toBe(201);
    const sessionId = (
      await waitFor("ready status of run A", appA, (info) =>
        info.status === "ready" ? info : undefined,
      )
    ).id;

    const before = summarize(await getMessages(appA));
    expect(before).toStrictEqual([
      { role: "user", text: PROMPT },
      { role: "assistant", text: FIRST_ANSWER },
    ]);

    // Stops Pi only: the workspace and the saved state stay in the dataDir.
    await runtimeA.close();
    current = undefined;

    // Run B: same config, so the gateway restores the session and starts Pi with the same id.
    const runtimeB = await startGateway();
    const appB = runtimeB.app;
    const restored = await waitFor("ready status after the restart", appB, (info) =>
      info.status === "ready" ? info : undefined,
    );
    expect(restored.id).toBe(sessionId);

    // Pi reopened the conversation from its JSONL: the same two messages, in the same order.
    const after = summarize(await getMessages(appB));
    expect(after).toStrictEqual(before);

    // The gateway told the clients about the conversation with a `history` event.
    const history = await waitForHistory(appB);
    expect(summarize(history)).toStrictEqual(before);

    // A new prompt in run B: the answer comes and the conversation grows to four messages.
    const posted = await appB.request("/session/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SECOND_PROMPT }),
    });
    expect(posted.status).toBe(200);
    await waitForMessageCount(appB, 4);
    expect(summarize(await getMessages(appB))).toStrictEqual([
      ...before,
      { role: "user", text: SECOND_PROMPT },
      { role: "assistant", text: SECOND_ANSWER },
    ]);

    // The model received the restored conversation with the second prompt.
    const secondRequest = JSON.stringify(requireValue(mock, "mock").requests[1]);
    expect(secondRequest).toContain(FIRST_ANSWER);
    expect(secondRequest).toContain(SECOND_PROMPT);
  }, 120_000);
});
