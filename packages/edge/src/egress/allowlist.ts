import { isIPv4 } from "node:net";

export interface AllowlistEntry {
  /** Lowercase, no trailing dot. For wildcards, the suffix WITHOUT "*." (e.g. "github.com"). */
  host: string;
  wildcard: boolean;
  /** Undefined = default ports only. */
  port?: number;
}

/** Ports an entry without explicit port matches. */
export const DEFAULT_ENTRY_PORTS: readonly number[] = [80, 443];

/** Decimal port without leading zeros or signs. */
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
/** One DNS label: letters, digits, hyphen and underscore; no leading or trailing hyphen. */
const DNS_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const MAX_HOST_LENGTH = 253;

/** True if `text` contains a control character, a space or DEL. */
function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Lowercases a host name and removes one trailing dot. */
function normalizeName(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Parses "host", "host:port", "*.domain" or "*.domain:port". Case-insensitive; a trailing dot in the host is removed.
 * Rejects (throws Error with the offending text in the message): empty, spaces, scheme ("https://..."), path ("/"),
 * a "*" anywhere other than a leading "*.", bare "*", wildcards whose suffix has fewer than 2 labels ("*.com"),
 * port outside 1..65535 or non-decimal, IPv6 literals (not supported in phase 1), labels that are empty ("a..b").
 * IPv4 literals are accepted as hosts (no wildcard).
 */
export function parseAllowlistEntry(text: string): AllowlistEntry {
  const reject = (reason: string): never => {
    throw new Error(`invalid allowlist entry "${text}": ${reason}`);
  };

  if (text.length === 0) reject("empty entry");
  if (hasControlOrSpace(text)) reject("spaces or control characters are not allowed");
  if (text.includes("://")) reject("schemes are not allowed");
  if (text.includes("/")) reject("paths are not allowed");
  if (text.includes("[") || text.includes("]")) reject("IPv6 literals are not supported");

  let hostText = text;
  let port: number | undefined;
  const colon = text.lastIndexOf(":");
  if (colon !== -1) {
    hostText = text.slice(0, colon);
    const portText = text.slice(colon + 1);
    if (!PORT_PATTERN.test(portText)) reject("port must be an integer between 1 and 65535");
    port = Number(portText);
    if (port < 1 || port > 65535) reject("port must be an integer between 1 and 65535");
  }
  if (hostText.includes(":")) reject("IPv6 literals are not supported");

  let host = normalizeName(hostText);
  let wildcard = false;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host.includes("*")) reject("'*' is only allowed as a leading '*.'");

  if (host.length === 0 || host.length > MAX_HOST_LENGTH) reject("invalid host name");
  const labels = host.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label))) reject("invalid host name");

  if (wildcard) {
    if (labels.length < 2) reject("wildcard suffix must have at least two labels");
    if (isIPv4(host)) reject("wildcards cannot be IP literals");
  }

  return port === undefined ? { host, wildcard } : { host, wildcard, port };
}

/** Back to canonical text: "host", "host:port", "*.suffix", "*.suffix:port". */
export function formatAllowlistEntry(entry: AllowlistEntry): string {
  const base = entry.wildcard ? `*.${entry.host}` : entry.host;
  return entry.port === undefined ? base : `${base}:${entry.port}`;
}

/**
 * True if host:port matches any entry. host is compared lowercase without trailing dot.
 * Exact entry: host equal. Wildcard: host ends with "." + suffix (any depth) and is NOT the suffix itself.
 * Port: entry.port if defined, else DEFAULT_ENTRY_PORTS.
 */
export function matchesAllowlist(
  entries: readonly AllowlistEntry[],
  host: string,
  port: number,
): boolean {
  const name = normalizeName(host);
  if (name.length === 0) return false;
  return entries.some((entry) => {
    const ports: readonly number[] = entry.port === undefined ? DEFAULT_ENTRY_PORTS : [entry.port];
    if (!ports.includes(port)) return false;
    if (!entry.wildcard) return name === entry.host;
    return name.endsWith(`.${entry.host}`);
  });
}

/** Base allowlist from the plan, as text (parsed by callers with parseAllowlistEntry). */
export const BASE_ALLOWLIST: readonly string[] = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "proxy.golang.org",
  "sum.golang.org",
  "services.gradle.org",
  "downloads.gradle.org",
  "nodejs.org",
  "go.dev",
  "dl.google.com",
  "api.adoptium.net",
  "mise.jdx.dev",
];
