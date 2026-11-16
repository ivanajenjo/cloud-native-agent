import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { NetworkDecision, NetworkDecisionReason, ProviderEndpoint } from "@cna/shared";
import { isInternalAddress } from "./address.js";
import { type AllowlistEntry, matchesAllowlist } from "./allowlist.js";
import type { AskCoordinator } from "./ask.js";
import type { PolicyStore } from "./policy-store.js";

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
export type Policy = (input: PolicyInput) => PolicyResult | Promise<PolicyResult>;

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
export function createAuditPolicy(options?: {
  allowedPorts?: readonly number[];
}): (input: PolicyInput) => PolicyResult {
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

export interface NetworkPolicyOptions {
  /** Mode and "allow always" entries, read on every decision (they can change at runtime). */
  store: Pick<PolicyStore, "get" | "entries" | "addAllow">;
  /** Parsed BASE_ALLOWLIST (plus any fixed entries). */
  baseAllowlist: readonly AllowlistEntry[];
  /** Endpoints of providers.yaml. */
  providers: readonly ProviderEndpoint[];
  ask: Pick<AskCoordinator, "ask">;
  /** Default DEFAULT_ALLOWED_PORTS ([80, 443]). */
  allowedPorts?: readonly number[];
  /** Called when persisting "allow always" fails; the connection is still allowed once. Default: no-op. */
  onPersistError?: (error: unknown) => void;
}

/** Lowercases a host name and removes one trailing dot. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Network policy for modes `ask` (default), `allowlist` and `audit`. Evaluation order:
 * 1. No addresses → deny `dns_error`.
 * 2. Host and port are a provider endpoint → allow `provider` (even if internal or on another port).
 * 3. Any address is internal → deny `internal_destination`.
 * 4. Mode `audit`: allowed port → allow `audit`; otherwise deny `port_not_allowed`.
 * 5. Matches the base allowlist or the stored entries → allow `allowlist`.
 * 6. Port not in `allowedPorts` → deny `port_not_allowed`.
 * 7. Mode `allowlist` → deny `not_allowed`.
 * 8. Mode `ask` → ask the user: `allow_once` → allow `user_once`; `allow_always` → persist the
 *    host and allow `user_always`; `deny` → deny `user_denied`; timeout → deny `ask_timeout`;
 *    no session → deny `no_session`.
 */
export function createNetworkPolicy(options: NetworkPolicyOptions): Policy {
  const allowedPorts = new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
  const onPersistError = options.onPersistError ?? (() => undefined);
  const allow = (reason: NetworkDecisionReason): PolicyResult => ({ decision: "allow", reason });
  const deny = (reason: NetworkDecisionReason): PolicyResult => ({ decision: "deny", reason });

  return async ({ host: rawHost, port, addresses }) => {
    const host = normalizeHost(rawHost);
    const { mode } = options.store.get();

    if (addresses.length === 0) return deny("dns_error");
    if (options.providers.some((endpoint) => host === endpoint.host && port === endpoint.port)) {
      return allow("provider");
    }
    if (addresses.some((address) => isInternalAddress(address))) {
      return deny("internal_destination");
    }
    if (mode === "audit") {
      return allowedPorts.has(port) ? allow("audit") : deny("port_not_allowed");
    }

    const entries = [...options.baseAllowlist, ...options.store.entries()];
    if (matchesAllowlist(entries, host, port)) return allow("allowlist");
    if (!allowedPorts.has(port)) return deny("port_not_allowed");
    if (mode === "allowlist") return deny("not_allowed");

    switch (await options.ask.ask(host, port)) {
      case "allow_once":
        return allow("user_once");
      case "allow_always":
        try {
          await options.store.addAllow(host);
        } catch (error) {
          onPersistError(error);
        }
        return allow("user_always");
      case "deny":
        return deny("user_denied");
      case "timeout":
        return deny("ask_timeout");
      case "no_session":
        return deny("no_session");
    }
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
