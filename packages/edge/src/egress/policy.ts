import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { NetworkDecision, NetworkDecisionReason } from "@cna/shared";
import { isInternalAddress } from "./address.js";

export interface PolicyInput {
  host: string;
  port: number;
  /** All resolved addresses of host (or [host] if it is an IP literal). */
  addresses: string[];
}

export interface PolicyResult {
  decision: NetworkDecision;
  reason: NetworkDecisionReason;
}

/**
 * Decides whether a connection to `host:port` may go out.
 *
 * Callers must connect to one of the `addresses` already validated here and must not resolve
 * the name again: a second lookup could return an internal address (DNS rebinding).
 */
export type Policy = (input: PolicyInput) => PolicyResult;

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/**
 * Phase 0 policy (`audit`): every external destination on an allowed port is allowed and logged.
 * Evaluation order:
 * 1. Port not in `allowedPorts` → deny `port_not_allowed`.
 * 2. No addresses → deny `dns_error`.
 * 3. Any address is internal → deny `internal_destination` (a name that resolves to both a public
 *    and a private address is denied).
 * 4. Otherwise allow `audit`.
 */
export function createAuditPolicy(options?: { allowedPorts?: readonly number[] }): Policy {
  const allowedPorts = new Set(options?.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
  return ({ port, addresses }) => {
    if (!allowedPorts.has(port)) {
      return { decision: "deny", reason: "port_not_allowed" };
    }
    if (addresses.length === 0) {
      return { decision: "deny", reason: "dns_error" };
    }
    if (addresses.some((address) => isInternalAddress(address))) {
      return { decision: "deny", reason: "internal_destination" };
    }
    return { decision: "allow", reason: "audit" };
  };
}

export type Resolver = (host: string) => Promise<string[]>;

/**
 * Resolves with dns.lookup(host, { all: true, verbatim: true }); IP literals are returned as-is
 * without DNS. A failed lookup resolves to [] so the policy denies it as `dns_error`.
 */
export const systemResolver: Resolver = async (host) => {
  if (isIP(host) !== 0) return [host];
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
};
