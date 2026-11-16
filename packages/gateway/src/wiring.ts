import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { listModels, loadProvidersConfig, writeModelsJson } from "./config/models.js";
import { type GatewayConfig, gatewayPaths } from "./config.js";
import { EventLog } from "./events/event-log.js";
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

  await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(dirname(paths.workspaceDir), { recursive: true });
  await writeModelsJson(paths.agentDir, providers);
  await copyFile(paths.globalAgentsFile, join(paths.agentDir, "AGENTS.md"));

  // The redactor sees every secret in env, API token included.
  const redactor = createRedactor(secretsFromEnv(env));
  // Git and Pi get the environment without the API token.
  const childEnv = withoutApiToken(env);
  const events = new EventLog();
  const git = createGitRunner(childEnv);

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
      env: childEnv,
    },
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
    close: () => manager.shutdown(),
  };
}

function withoutApiToken(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const copy = { ...env };
  delete copy[API_TOKEN_VARIABLE];
  return copy;
}
