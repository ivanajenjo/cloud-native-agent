import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORTS, parsePort } from "@cna/shared";

export interface GatewayConfig {
  /** GATEWAY_PORT, default DEFAULT_PORTS.gateway. */
  port: number;
  /** CNA_DATA_DIR, default "/data". Absolute. */
  dataDir: string;
  /** CNA_PROVIDERS_FILE, default "/config/providers.yaml". Absolute. */
  providersFile: string;
  /** CNA_NOTIFICATIONS_FILE, default "/config/notifications.yaml". Absolute. */
  notificationsFile: string;
  /** CNA_WEB_FILE, default "/config/web.yaml". Absolute. */
  webFile: string;
  /** CNA_EXTENSIONS_DIR, default: the folder of the @cna/extensions package. Absolute. */
  extensionsDir: string;
  /** CNA_WEB_UI_DIR, default: the dist folder of the @cna/web package. Absolute. */
  webUiDir: string;
  /** CNA_GIT_USER_NAME. Empty or absent means undefined. */
  gitUserName?: string;
  /** CNA_GIT_USER_EMAIL. Empty or absent means undefined. */
  gitUserEmail?: string;
  /** CNA_IDLE_TIMEOUT_MIN (integer minutes, 0..10080, default 30), in ms. 0 disables the suspension. */
  idleTimeoutMs: number;
}

/** Paths derived from the configuration. */
export interface GatewayPaths {
  /** <dataDir>/workspace/repo */
  workspaceDir: string;
  /** <dataDir>/config/pi (PI_CODING_AGENT_DIR). */
  agentDir: string;
  /** <dataDir>/sessions */
  sessionDir: string;
  /** <dataDir>/logs/tools.jsonl (tool execution log). */
  toolLogFile: string;
  /** Extension files passed to Pi with -e, in order. */
  extensions: string[];
  /** Passed to Pi with --append-system-prompt. */
  systemPromptFile: string;
  /** Copied to <agentDir>/AGENTS.md (global instructions of Pi). */
  globalAgentsFile: string;
  /** <dataDir>/state/session.json (ADR-0011 §2). */
  stateFile: string;
  /** <dataDir>/state/history.json (ADR-0011 §6). */
  historyFile: string;
}

const DEFAULT_DATA_DIR = "/data";
const DEFAULT_IDLE_TIMEOUT_MIN = 30;
const MAX_IDLE_TIMEOUT_MIN = 10_080;
const MS_PER_MINUTE = 60_000;
const DEFAULT_PROVIDERS_FILE = "/config/providers.yaml";
const DEFAULT_NOTIFICATIONS_FILE = "/config/notifications.yaml";
const DEFAULT_WEB_FILE = "/config/web.yaml";
/** Resolved from this module, so it is the same from src/ (tests) and from dist/ (production). */
const DEFAULT_EXTENSIONS_DIR = fileURLToPath(new URL("../../extensions", import.meta.url));
/** Same trick as DEFAULT_EXTENSIONS_DIR: the same relative depth from src/ and dist/. */
const DEFAULT_WEB_UI_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * Reads the gateway's configuration from `env`. Throws an `Error` with a clear message on any
 * invalid value. Messages name the variable and never echo its value.
 */
export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  return {
    port: parseGatewayPort(env.GATEWAY_PORT),
    dataDir: parseAbsolutePath("CNA_DATA_DIR", env.CNA_DATA_DIR ?? DEFAULT_DATA_DIR),
    providersFile: parseAbsolutePath(
      "CNA_PROVIDERS_FILE",
      env.CNA_PROVIDERS_FILE ?? DEFAULT_PROVIDERS_FILE,
    ),
    notificationsFile: parseAbsolutePath(
      "CNA_NOTIFICATIONS_FILE",
      env.CNA_NOTIFICATIONS_FILE ?? DEFAULT_NOTIFICATIONS_FILE,
    ),
    webFile: parseAbsolutePath("CNA_WEB_FILE", env.CNA_WEB_FILE ?? DEFAULT_WEB_FILE),
    extensionsDir: parseAbsolutePath(
      "CNA_EXTENSIONS_DIR",
      env.CNA_EXTENSIONS_DIR ?? DEFAULT_EXTENSIONS_DIR,
    ),
    webUiDir: parseAbsolutePath("CNA_WEB_UI_DIR", env.CNA_WEB_UI_DIR ?? DEFAULT_WEB_UI_DIR),
    gitUserName: optionalValue(env.CNA_GIT_USER_NAME),
    gitUserEmail: optionalValue(env.CNA_GIT_USER_EMAIL),
    idleTimeoutMs: parseIdleTimeoutMs(env.CNA_IDLE_TIMEOUT_MIN),
  };
}

/** Derives the gateway's paths from its configuration. Pure: it does not touch the disk. */
export function gatewayPaths(config: GatewayConfig): GatewayPaths {
  const { dataDir, extensionsDir } = config;
  const srcDir = join(extensionsDir, "src");
  const assetsDir = join(extensionsDir, "assets");
  return {
    workspaceDir: join(dataDir, "workspace", "repo"),
    agentDir: join(dataDir, "config", "pi"),
    sessionDir: join(dataDir, "sessions"),
    toolLogFile: join(dataDir, "logs", "tools.jsonl"),
    extensions: [
      join(srcDir, "ask-user.ts"),
      join(srcDir, "git.ts"),
      join(srcDir, "todo.ts"),
      join(srcDir, "plan-mode.ts"),
      join(srcDir, "guard.ts"),
      join(srcDir, "web.ts"),
    ],
    systemPromptFile: join(assetsDir, "system-prompt.md"),
    globalAgentsFile: join(assetsDir, "AGENTS.md"),
    stateFile: join(dataDir, "state", "session.json"),
    historyFile: join(dataDir, "state", "history.json"),
  };
}

/** Wraps parsePort so the message names the variable and never echoes its value. */
function parseGatewayPort(value: string | undefined): number {
  try {
    return parsePort(value, DEFAULT_PORTS.gateway);
  } catch {
    throw new Error("GATEWAY_PORT must be an integer between 1 and 65535");
  }
}

function parseAbsolutePath(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

/** Empty means absent. */
function optionalValue(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Absent or empty means the default. Returns milliseconds; the message never echoes the value. */
function parseIdleTimeoutMs(value: string | undefined): number {
  const text = optionalValue(value);
  if (text === undefined) {
    return DEFAULT_IDLE_TIMEOUT_MIN * MS_PER_MINUTE;
  }
  const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(minutes) || minutes > MAX_IDLE_TIMEOUT_MIN) {
    throw new Error("CNA_IDLE_TIMEOUT_MIN must be an integer between 0 and 10080");
  }
  return minutes * MS_PER_MINUTE;
}
