/** How the outbound proxy received the request. */
export type NetworkMethod = "CONNECT" | "HTTP";

export type NetworkDecision = "allow" | "deny";

/**
 * Why a decision was taken.
 * - `audit`: allowed because the policy mode is `audit`.
 * - `internal_destination`: the host is, or resolves to, a loopback/private/link-local/... address.
 * - `port_not_allowed`: the port is not in the allowed set (80 and 443 by default).
 * - `invalid_target`: the request target could not be parsed.
 * - `dns_error`: the host could not be resolved.
 */
export type NetworkDecisionReason =
  | "audit"
  | "internal_destination"
  | "port_not_allowed"
  | "invalid_target"
  | "dns_error";

/** Policy modes. Phase 0 only implements `audit`; `ask` (default) and `allowlist` come in phase 1. */
export type NetworkMode = "ask" | "allowlist" | "audit";

/** One line of `network.jsonl` in edge's volume. One entry per proxied connection or request. */
export interface NetworkLogEntry {
  /** ISO 8601 timestamp of when the request arrived. */
  ts: string;
  method: NetworkMethod;
  /** Lowercased host as requested (name or IP literal, IPv6 without brackets). Empty if unparseable. */
  host: string;
  /** 0 if unparseable. */
  port: number;
  decision: NetworkDecision;
  reason: NetworkDecisionReason;
  /** Bytes sent from the client to the destination. */
  bytesOut: number;
  /** Bytes sent from the destination back to the client. */
  bytesIn: number;
  /** Time from arrival until the connection closed. */
  durationMs: number;
  /** Upstream connection error message, if any. Never contains credentials. */
  error?: string;
}
