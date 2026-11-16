import { isAbsolute } from "node:path";
import { DEFAULT_PORTS, parsePort } from "@cna/shared";

export interface EdgeConfig {
  token: string;
  gatewayUrl: string; // normalized, no trailing slash
  dataDir: string;
  apiPort: number;
  proxyPort: number;
  /** providers.yaml mounted read-only (EDGE_PROVIDERS_FILE, default "/config/providers.yaml"). Absolute path. */
  providersFile: string;
  /** notifications.yaml mounted read-only (EDGE_NOTIFICATIONS_FILE, default "/config/notifications.yaml"). Absolute path. */
  notificationsFile: string;
  /** web.yaml mounted read-only (EDGE_WEB_FILE, default "/config/web.yaml"). Absolute path. */
  webFile: string;
  /** Network question timeout (EDGE_ASK_TIMEOUT_MS, default 120000). Integer in [1000, 3600000]. */
  askTimeoutMs: number;
}

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_GATEWAY_URL = "http://agent:8090";
const DEFAULT_DATA_DIR = "/edge-data";
const DEFAULT_PROVIDERS_FILE = "/config/providers.yaml";
const DEFAULT_NOTIFICATIONS_FILE = "/config/notifications.yaml";
const DEFAULT_WEB_FILE = "/config/web.yaml";
const DEFAULT_ASK_TIMEOUT_MS = 120_000;
const MIN_ASK_TIMEOUT_MS = 1000;
const MAX_ASK_TIMEOUT_MS = 3_600_000;
/** Decimal digits only: no sign, no exponent, no decimal point. */
const DIGITS_PATTERN = /^[0-9]+$/;

/** Whitespace or control characters. The message for these never echoes the token. */
const FORBIDDEN_TOKEN_CHARS = /[\s\p{Cc}]/u;

/**
 * Reads edge's configuration from `env`. Throws an `Error` with a clear message on any invalid
 * value. No message ever contains the value of `AGENT_API_TOKEN`, not even partially; the
 * `GATEWAY_URL` messages omit the value too, because it may carry credentials.
 */
export function loadConfig(env: Record<string, string | undefined>): EdgeConfig {
  const token = parseToken(env.AGENT_API_TOKEN);
  const gatewayUrl = parseGatewayUrl(env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  const dataDir = parseDataDir(env.EDGE_DATA_DIR ?? DEFAULT_DATA_DIR);
  const apiPort = parsePortVariable("EDGE_API_PORT", env.EDGE_API_PORT, DEFAULT_PORTS.edgeApi);
  const proxyPort = parsePortVariable(
    "EDGE_PROXY_PORT",
    env.EDGE_PROXY_PORT,
    DEFAULT_PORTS.edgeProxy,
  );
  const providersFile = parseAbsolutePath(
    "EDGE_PROVIDERS_FILE",
    env.EDGE_PROVIDERS_FILE,
    DEFAULT_PROVIDERS_FILE,
  );
  const notificationsFile = parseAbsolutePath(
    "EDGE_NOTIFICATIONS_FILE",
    env.EDGE_NOTIFICATIONS_FILE,
    DEFAULT_NOTIFICATIONS_FILE,
  );
  const webFile = parseAbsolutePath("EDGE_WEB_FILE", env.EDGE_WEB_FILE, DEFAULT_WEB_FILE);
  const askTimeoutMs = parseAskTimeout(env.EDGE_ASK_TIMEOUT_MS);

  if (apiPort === proxyPort) {
    throw new Error("EDGE_API_PORT and EDGE_PROXY_PORT must be different");
  }

  return {
    token,
    gatewayUrl,
    dataDir,
    apiPort,
    proxyPort,
    providersFile,
    notificationsFile,
    webFile,
    askTimeoutMs,
  };
}

function parseToken(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("AGENT_API_TOKEN is required (generate one with: openssl rand -hex 32)");
  }
  if (value.length < MIN_TOKEN_LENGTH) {
    throw new Error(`AGENT_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long`);
  }
  if (FORBIDDEN_TOKEN_CHARS.test(value)) {
    throw new Error("AGENT_API_TOKEN must not contain spaces or control characters");
  }
  return value;
}

function parseGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GATEWAY_URL must be a valid URL, for example http://agent:8090");
  }
  if (url.protocol !== "http:") {
    throw new Error("GATEWAY_URL must use the http: protocol");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("GATEWAY_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("GATEWAY_URL must not contain a query or a fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("GATEWAY_URL must not contain a path");
  }
  // origin has no trailing slash, unlike href.
  return url.origin;
}

function parseDataDir(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("EDGE_DATA_DIR must be an absolute path");
  }
  return value;
}

/** Config file path: absolute, or absent (then the default). Names the variable on error. */
function parseAbsolutePath(name: string, value: string | undefined, fallback: string): string {
  const path = value ?? fallback;
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path;
}

/** Milliseconds, digits only. Absent → default. Never echoes the value. */
function parseAskTimeout(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_ASK_TIMEOUT_MS;
  }
  const timeout = DIGITS_PATTERN.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_ASK_TIMEOUT_MS ||
    timeout > MAX_ASK_TIMEOUT_MS
  ) {
    throw new Error(
      `EDGE_ASK_TIMEOUT_MS must be an integer between ${MIN_ASK_TIMEOUT_MS} and ${MAX_ASK_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

/** Wraps parsePort so the message names the variable and never echoes its value. */
function parsePortVariable(name: string, value: string | undefined, fallback: number): number {
  try {
    return parsePort(value, fallback);
  } catch {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}
