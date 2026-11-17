import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@cna/shared";

export interface PiLaunchOptions {
  /** Absolute path of Pi's CLI JS entry (see resolvePiCli). */
  piCli: string;
  /** Workspace (the cloned repo). */
  cwd: string;
  /** PI_CODING_AGENT_DIR: generated config (models.json, global AGENTS.md). */
  agentDir: string;
  /** Where Pi stores the session JSONL. */
  sessionDir: string;
  /** Pi session id (`--session-id`): the SessionInfo id, so a restarted Pi resumes the conversation (ADR-0011). */
  sessionId: string;
  /** Absolute paths of our extensions, each passed with -e, in order. */
  extensions: string[];
  /** File passed with --append-system-prompt, if any. */
  systemPromptFile?: string;
  /** "provider/model-id". */
  model?: string;
  thinking?: ThinkingLevel;
  /** Flags read by our git extension. */
  baseBranch: string;
  autoPush: boolean;
  /** Flag read by the plan-mode extension: the session starts in plan mode. */
  plan?: boolean;
  /** Absolute path of web.yaml, read by the web extension (--cna-web-config). */
  webConfigFile?: string;
  /** Base environment (normally process.env). */
  env: Record<string, string | undefined>;
  /** Node binary. Default process.execPath. */
  nodePath?: string;
}

export interface PiLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Variable that must never reach Pi's process: only `edge` holds the API token. */
const FORBIDDEN_ENV = "AGENT_API_TOKEN";

/** Pi session id: alphanumeric at both ends, up to 128 characters, no `/` nor leading `-`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

function assertAbsolute(label: string, value: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path: ${value}`);
  }
}

function validate(options: PiLaunchOptions): void {
  assertAbsolute("cwd", options.cwd);
  assertAbsolute("agentDir", options.agentDir);
  assertAbsolute("sessionDir", options.sessionDir);
  assertAbsolute("piCli", options.piCli);
  for (const extension of options.extensions) {
    assertAbsolute("extension", extension);
  }
  if (options.systemPromptFile !== undefined) {
    assertAbsolute("systemPromptFile", options.systemPromptFile);
  }
  if (options.webConfigFile !== undefined) {
    assertAbsolute("webConfigFile", options.webConfigFile);
  }
  if (!SESSION_ID_PATTERN.test(options.sessionId)) {
    throw new Error("sessionId is not valid");
  }
  if (options.baseBranch.length === 0) {
    throw new Error("baseBranch must not be empty");
  }
  if (options.baseBranch.startsWith("-")) {
    throw new Error(`baseBranch must not start with "-": ${options.baseBranch}`);
  }
  if (options.model?.startsWith("-")) {
    throw new Error(`model must not start with "-": ${options.model}`);
  }
}

function buildEnv(
  base: Record<string, string | undefined>,
  agentDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key === FORBIDDEN_ENV) {
      continue;
    }
    env[key] = value;
  }
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

function buildArgs(options: PiLaunchOptions): string[] {
  const args: string[] = [
    options.piCli,
    "--mode",
    "rpc",
    "--no-approve",
    "--no-extensions",
    "--no-mcp",
    "--session-dir",
    options.sessionDir,
    "--session-id",
    options.sessionId,
  ];
  for (const extension of options.extensions) {
    args.push("-e", extension);
  }
  if (options.systemPromptFile !== undefined) {
    args.push("--append-system-prompt", options.systemPromptFile);
  }
  if (options.model !== undefined) {
    args.push("--model", options.model);
  }
  if (options.thinking !== undefined) {
    args.push("--thinking", options.thinking);
  }
  args.push("--cna-base-branch", options.baseBranch);
  if (options.autoPush) {
    args.push("--cna-auto-push");
  }
  if (options.plan) {
    args.push("--cna-plan");
  }
  if (options.webConfigFile !== undefined) {
    args.push("--cna-web-config", options.webConfigFile);
  }
  return args;
}

/**
 * Builds the command, arguments and environment used to spawn `pi --mode rpc`.
 * Pure: it does not spawn anything.
 */
export function buildPiLaunch(options: PiLaunchOptions): PiLaunchSpec {
  validate(options);
  return {
    command: options.nodePath ?? process.execPath,
    args: buildArgs(options),
    cwd: options.cwd,
    env: buildEnv(options.env, options.agentDir),
  };
}

/**
 * Absolute path of `dist/bundle/cli.js` of @earendil-works/pi-coding-agent, located
 * from the package's main entry (`dist/index.js`).
 */
export function resolvePiCli(): string {
  const indexPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const cliPath = join(dirname(indexPath), "bundle", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`Pi CLI not found at ${cliPath}`);
  }
  return cliPath;
}
