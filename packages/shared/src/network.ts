/** How the outbound proxy received the request. */
export type NetworkMethod = "CONNECT" | "HTTP";

export type NetworkDecision = "allow" | "deny";

/**
 * Why a decision was taken.
 * - `audit`: allowed because the policy mode is `audit`.
 * - `allowlist`: the destination matches an allowlist entry (base, configured or "allow always").
 * - `provider`: the destination is the endpoint of a provider in `providers.yaml`.
 * - `service`: the destination is the endpoint of a configured service (notifications.yaml,
 *   web.yaml; ADR-0009).
 * - `user_once` / `user_always`: the user allowed it in a network question.
 * - `user_denied`: the user denied it in a network question.
 * - `ask_timeout`: nobody answered the network question in time.
 * - `no_session`: mode `ask` but there is no active session to ask (or the gateway is down).
 * - `not_allowed`: mode `allowlist` and the destination is not listed.
 * - `internal_destination`: the host is, or resolves to, a loopback/private/link-local/... address.
 * - `port_not_allowed`: the port is not in the allowed set (80 and 443 by default).
 * - `invalid_target`: the request target could not be parsed.
 * - `dns_error`: the host could not be resolved.
 */
export const NETWORK_DECISION_REASONS = [
  "audit",
  "allowlist",
  "provider",
  "service",
  "user_once",
  "user_always",
  "user_denied",
  "ask_timeout",
  "no_session",
  "not_allowed",
  "internal_destination",
  "port_not_allowed",
  "invalid_target",
  "dns_error",
] as const;
export type NetworkDecisionReason = (typeof NETWORK_DECISION_REASONS)[number];

/** Policy modes. `ask` is the default. */
export const NETWORK_MODES = ["ask", "allowlist", "audit"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

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
