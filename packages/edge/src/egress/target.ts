import { isIPv4, isIPv6 } from "node:net";

export interface ProxyTarget {
  host: string;
  port: number;
}

/** True if `text` contains a control character, a space or DEL: never valid inside a proxy target. */
function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}
/** Decimal port without leading zeros or signs. */
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
/** One DNS label: letters, digits, hyphen and underscore; no leading or trailing hyphen. */
const DNS_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** Parses a port string; returns null unless it is a decimal integer in 1–65535. */
function parsePort(text: string): number | null {
  if (!PORT_PATTERN.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Normalizes and validates a host name or IPv4 literal: lowercase, one trailing dot removed,
 * and each DNS label checked. Returns null if invalid.
 */
function normalizeHost(raw: string): string | null {
  let host = raw.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  if (isIPv4(host)) return host;
  const labels = host.split(".");
  return labels.every((label) => DNS_LABEL.test(label)) ? host : null;
}

/** Parses a CONNECT authority ("host:port", "[v6]:port"). Returns null if invalid. Port is mandatory. */
export function parseConnectAuthority(authority: string): ProxyTarget | null {
  if (typeof authority !== "string" || hasControlOrSpace(authority)) return null;
  if (authority.includes("@")) return null;

  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1 || authority[close + 1] !== ":") return null;
    const literal = authority.slice(1, close).toLowerCase();
    // Zone identifiers (fe80::1%eth0) are not accepted: fail closed.
    if (literal.includes("%") || !isIPv6(literal)) return null;
    const port = parsePort(authority.slice(close + 2));
    return port === null ? null : { host: literal, port };
  }

  const colon = authority.lastIndexOf(":");
  if (colon === -1) return null;
  const rawHost = authority.slice(0, colon);
  // An unbracketed IPv6 literal would be ambiguous with the port separator.
  if (rawHost.includes(":")) return null;
  const host = normalizeHost(rawHost);
  const port = parsePort(authority.slice(colon + 1));
  if (host === null || port === null) return null;
  return { host, port };
}

/**
 * Parses an absolute-form proxy request URL ("http://host[:port]/path"). Only http: is accepted
 * (https goes through CONNECT). Default port 80. Returns null if invalid.
 */
export function parseHttpProxyUrl(url: string): (ProxyTarget & { path: string }) | null {
  if (typeof url !== "string" || hasControlOrSpace(url)) return null;

  // Reject any "@" in the authority part, even an empty userinfo ("http://@host/").
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i.exec(url);
  if (authority?.[1]?.includes("@")) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;

  let host: string | null;
  if (parsed.hostname.startsWith("[")) {
    const literal = parsed.hostname.slice(1, -1);
    host = isIPv6(literal) ? literal : null;
  } else {
    host = normalizeHost(parsed.hostname);
  }
  if (host === null) return null;

  const port = parsed.port === "" ? 80 : parsePort(parsed.port);
  if (port === null) return null;

  return { host, port, path: `${parsed.pathname}${parsed.search}` };
}
