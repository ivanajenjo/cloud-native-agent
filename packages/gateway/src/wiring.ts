import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseWebConfig, resolveSecretRef } from "@cna/shared";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import {
  listModels,
  loadProvidersConfig,
  providerSecrets,
  writeModelsJson,
} from "./config/models.js";
import { type GatewayConfig, gatewayPaths } from "./config.js";
import { EventLog } from "./events/event-log.js";
import { createToolLog } from "./logs/tool-log.js";
import { resolvePiCli } from "./pi/launch.js";
import { createRedactor, secretsFromEnv } from "./redact.js";
import { RpcBridge, type RpcBridgeHandlers } from "./rpc/bridge.js";
import { type PiProcess, SessionManager, type SessionManagerOptions } from "./session/manager.js";
import { createGitRunner } from "./workspace/git.js";

export interface GatewayRuntime {
  app: Hono;
  /** Stops Pi if running. */
  close(): Promise<void>;
}

export interface GatewayWiringOptions {
  config: GatewayConfig;
  version: string;
  /** Normally process.env. */
  env: Record<string, string | undefined>;
  /** Injectable for tests. Default (spec, handlers) => RpcBridge.start(spec, handlers). */
  startPi?: SessionManagerOptions["startPi"];
  /** Injectable for tests. Default resolvePiCli(). */
  piCli?: string;
  /** Default "https://github.com/". Tests pass file://. */
  remoteBase?: string;
}

/** Variable that must never reach git or Pi: only `edge` holds the API token (AGENTS.md). */
const API_TOKEN_VARIABLE = "AGENT_API_TOKEN";

/**
 * Builds the gateway's runtime: writes Pi's generated config, creates the session manager and the
 * HTTP app. Throws (startup must fail) if providers.yaml is invalid or an extension file is missing.
 */
export async function createGatewayRuntime(options: GatewayWiringOptions): Promise<GatewayRuntime> {
  const { config, version, env } = options;
  const paths = gatewayPaths(config);

  const requiredFiles = [...paths.extensions, paths.systemPromptFile, paths.globalAgentsFile];
  for (const file of requiredFiles) {
    if (!existsSync(file)) {
      throw new Error(`extension file not found: ${file}`);
    }
  }

  const providers = await loadProvidersConfig(config.providersFile);
  const webSecrets = await loadWebSecrets(config.webFile, env);

  await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(dirname(paths.workspaceDir), { recursive: true });
  await writeModelsJson(paths.agentDir, providers);
  await copyFile(paths.globalAgentsFile, join(paths.agentDir, "AGENTS.md"));

  // The redactor sees every secret in env (API token included) and the keys of providers.yaml.
  const redactor = createRedactor([
    ...secretsFromEnv(env),
    ...providerSecrets(providers, env),
    ...webSecrets,
  ]);
  // Git and Pi get the environment without the API token.
  const childEnv = withoutApiToken(env);
  const events = new EventLog();
  const git = createGitRunner(childEnv);
  const toolLog = createToolLog({ filePath: paths.toolLogFile, redactor });

  const manager = new SessionManager({
    events,
    redactor,
    git,
    startPi:
      options.startPi ??
      ((spec, handlers: RpcBridgeHandlers): PiProcess => RpcBridge.start(spec, handlers)),
    pi: {
      piCli: options.piCli ?? resolvePiCli(),
      agentDir: paths.agentDir,
      sessionDir: paths.sessionDir,
      extensions: paths.extensions,
      systemPromptFile: paths.systemPromptFile,
      webConfigFile: config.webFile,
      env: childEnv,
    },
    toolLog,
    workspaceDir: paths.workspaceDir,
    defaultModel: providers.default,
    gitIdentity: { name: config.gitUserName, email: config.gitUserEmail },
    remoteBase: options.remoteBase,
  });

  const app = createApp({
    version,
    session: manager,
    events,
    models: () => listModels(providers),
  });

  return {
    app,
    close: async () => {
      await manager.shutdown();
      await toolLog.close();
    },
  };
}

/**
 * Secret values of web.yaml (the search API key), so they never reach logs or events. A missing
 * file means no web search. Other read errors and invalid files propagate: the gateway must not
 * start with a configuration it does not understand.
 */
async function loadWebSecrets(
  file: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const apiKey = parseWebConfig(text).search?.apiKey;
  const value = apiKey === undefined ? undefined : resolveSecretRef(apiKey, env);
  return value === undefined ? [] : [value];
}

function withoutApiToken(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const copy = { ...env };
  delete copy[API_TOKEN_VARIABLE];
  return copy;
}
