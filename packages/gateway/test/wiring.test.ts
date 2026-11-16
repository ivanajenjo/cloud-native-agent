import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionInfo } from "@cna/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_API_KEY } from "../src/config/models.js";
import { type GatewayConfig, gatewayPaths, loadGatewayConfig } from "../src/config.js";
import type { PiLaunchSpec } from "../src/pi/launch.js";
import type { RpcBridgeHandlers, RpcCommandInput } from "../src/rpc/bridge.js";
import type { PiProcess } from "../src/session/manager.js";
import { createGatewayRuntime, type GatewayRuntime } from "../src/wiring.js";
import { createGitRunner } from "../src/workspace/git.js";

const TOKEN = "ghp_test_secret_value";

const PROVIDERS_YAML = `default: ollama/qwen3-coder:30b
providers:
  ollama:
    baseUrl: http://192.168.1.50:11434/v1
    api: openai-completions
    models:
      - id: qwen3-coder:30b
        contextWindow: 65536
`;

/** Isolated from the machine's git config. */
const GIT_ENV: Record<string, string | undefined> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const realGit = createGitRunner(GIT_ENV);

let root: string;
let remoteBase: string;
let runtimes: GatewayRuntime[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-wiring-"));

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

  await writeFile(join(root, "providers.yaml"), PROVIDERS_YAML);
  runtimes = [];
});

afterEach(async () => {
  for (const runtime of runtimes) {
    await runtime.close();
  }
  await rm(root, { recursive: true, force: true });
});

/** Fake Pi: answers prompt with disposition "started" and nothing else. */
class FakePi implements PiProcess {
  readonly running = true;
  readonly send = vi.fn(async (command: RpcCommandInput) =>
    command.type === "prompt" ? { disposition: "started" } : undefined,
  );
  readonly respondUi = vi.fn();
  readonly stop = vi.fn(async () => undefined);
}

function configFor(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const dataDir = join(root, "data");
  return {
    port: 8090,
    dataDir,
    providersFile: join(root, "providers.yaml"),
    extensionsDir: loadGatewayConfig({}).extensionsDir,
    gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid",
    ...overrides,
  };
}

/** Env with the git isolation, identity, PATH and a GitHub token that must never leak. */
function testEnv(): Record<string, string | undefined> {
  return {
    ...GIT_ENV,
    PATH: process.env.PATH,
    GITHUB_TOKEN: TOKEN,
  };
}

async function start(config: GatewayConfig = configFor()) {
  const startPi = vi.fn<(spec: PiLaunchSpec, handlers: RpcBridgeHandlers) => PiProcess>(
    () => new FakePi(),
  );
  const runtime = await createGatewayRuntime({
    config,
    version: "0.0.0-test",
    env: testEnv(),
    startPi,
    piCli: join(root, "pi", "cli.js"),
    remoteBase,
  });
  runtimes.push(runtime);
  return { runtime, app: runtime.app as Hono, startPi, config };
}

async function waitForRunning(app: Hono): Promise<SessionInfo> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const info = (await (await app.request("/session")).json()) as SessionInfo;
    if (info.status === "running") {
      return info;
    }
    if (info.status === "error") {
      throw new Error(`session failed: ${info.error ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("session did not reach running within 5 s");
}

/** Reads the replay of the SSE stream until `needle` shows up, then closes the stream. */
async function readEventsUntil(app: Hono, needle: string): Promise<string> {
  const controller = new AbortController();
  const response = await app.request("/session/events", { signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("events stream has no body");
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(needle)) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

describe("createGatewayRuntime", () => {
  it("writes models.json and the global AGENTS.md into the agent dir", async () => {
    const { config } = await start();
    const paths = gatewayPaths(config);

    const models = JSON.parse(await readFile(join(paths.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { apiKey?: string; baseUrl?: string }>;
    };
    expect(models.providers.ollama?.apiKey).toBe(PLACEHOLDER_API_KEY);
    expect(models.providers.ollama?.baseUrl).toBe("http://192.168.1.50:11434/v1");

    const agentsCopy = await readFile(join(paths.agentDir, "AGENTS.md"), "utf8");
    const asset = await readFile(paths.globalAgentsFile, "utf8");
    expect(agentsCopy).toBe(asset);
  });

  it("answers GET /models with the model and the default", async () => {
    const { app } = await start();

    const response = await app.request("/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      default: "ollama/qwen3-coder:30b",
      models: [
        {
          ref: "ollama/qwen3-coder:30b",
          provider: "ollama",
          modelId: "qwen3-coder:30b",
          contextWindow: 65536,
        },
      ],
    });
  });

  it("starts Pi with the generated configuration and the workspace as cwd", async () => {
    const { app, startPi, config } = await start();
    const paths = gatewayPaths(config);

    const created = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "octo/hello", prompt: "hola" }),
    });
    expect(created.status).toBe(201);

    await waitForRunning(app);

    expect(startPi).toHaveBeenCalledTimes(1);
    const spec = startPi.mock.calls[0]?.[0] as PiLaunchSpec;
    expect(spec.env.PI_CODING_AGENT_DIR).toBe(paths.agentDir);
    expect(spec.cwd).toBe(paths.workspaceDir);
    expect(spec.args).toContain("--append-system-prompt");
    expect(spec.args[spec.args.indexOf("--append-system-prompt") + 1]).toBe(paths.systemPromptFile);
    expect(spec.args[spec.args.indexOf("--model") + 1]).toBe("ollama/qwen3-coder:30b");

    const extensionArgs = spec.args.flatMap((arg, index) =>
      arg === "-e" ? [spec.args[index + 1]] : [],
    );
    expect(extensionArgs).toStrictEqual(paths.extensions);
  }, 15_000);

  it("never leaks the GitHub token into the session info or the events", async () => {
    const { app } = await start();

    await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "octo/hello", prompt: "hola" }),
    });
    await waitForRunning(app);

    const info = await (await app.request("/session")).text();
    expect(info).not.toContain(TOKEN);

    const events = await readEventsUntil(app, '"status":"running"');
    expect(events).toContain('"status":"running"');
    expect(events).not.toContain(TOKEN);
  }, 15_000);

  it("redacts a literal apiKey of providers.yaml from the events", async () => {
    const apiKey = "sk-literal-provider-key";
    await writeFile(
      join(root, "providers.yaml"),
      `providers:\n  custom:\n    baseUrl: https://llm.example.invalid/v1\n    apiKey: ${apiKey}\n`,
    );
    const { app, startPi } = await start();

    await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "octo/hello", prompt: "hola" }),
    });
    await waitForRunning(app);

    const handlers = startPi.mock.calls[0]?.[1];
    handlers?.onEvent({
      type: "message_end",
      message: { role: "assistant", content: `the key is ${apiKey}, end-of-leak` },
    });

    const events = await readEventsUntil(app, "end-of-leak");
    expect(events).toContain("the key is [REDACTED], end-of-leak");
    expect(events).not.toContain(apiKey);
  }, 15_000);

  it("rejects when providers.yaml is invalid", async () => {
    await writeFile(join(root, "providers.yaml"), "providers:\n  ollama:\n    bogus: 1\n");

    await expect(
      createGatewayRuntime({
        config: configFor(),
        version: "0.0.0-test",
        env: testEnv(),
        piCli: join(root, "pi", "cli.js"),
      }),
    ).rejects.toThrow(/providers\.yaml/);
  });

  it("rejects when an extension file is missing", async () => {
    const emptyExtensions = join(root, "empty-extensions");
    await mkdir(emptyExtensions);

    await expect(
      createGatewayRuntime({
        config: configFor({ extensionsDir: emptyExtensions }),
        version: "0.0.0-test",
        env: testEnv(),
        piCli: join(root, "pi", "cli.js"),
      }),
    ).rejects.toThrow("extension file not found");
  });
});
