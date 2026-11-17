import type { NetworkMode, ProviderEndpoint, ServiceEndpoint } from "@cna/shared";
import { describe, expect, it, vi } from "vitest";
import { parseAllowlistEntry } from "../src/egress/allowlist.js";
import type { AskResult } from "../src/egress/ask.js";
import {
  createAuditPolicy,
  createNetworkPolicy,
  type NetworkPolicyOptions,
  systemResolver,
} from "../src/egress/policy.js";

const PUBLIC = "93.184.216.34";
const PRIVATE = "10.0.0.5";
const PRIVATE_LAN = "192.168.1.50";
const REPLICA = "agent-1";

interface Fixture {
  policy: ReturnType<typeof createNetworkPolicy>;
  ask: ReturnType<
    typeof vi.fn<(host: string, port: number, replica: string) => Promise<AskResult>>
  >;
  addAllow: ReturnType<typeof vi.fn<(entry: string) => Promise<void>>>;
  onPersistError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  setMode: (mode: NetworkMode) => void;
}

/** Network policy over an in-memory store and a fake ask coordinator. */
function fixture(
  options: {
    mode?: NetworkMode;
    allow?: string[];
    providers?: ProviderEndpoint[];
    services?: ServiceEndpoint[];
    answer?: AskResult;
  } = {},
): Fixture {
  const state: { mode: NetworkMode; allow: string[] } = {
    mode: options.mode ?? "ask",
    allow: [...(options.allow ?? [])],
  };
  const addAllow = vi.fn(async (entry: string): Promise<void> => {
    if (!state.allow.includes(entry)) state.allow.push(entry);
  });
  const ask = vi.fn(async (_host: string, _port: number, _replica: string): Promise<AskResult> => {
    return options.answer ?? "deny";
  });
  const onPersistError = vi.fn<(error: unknown) => void>();
  const store: NetworkPolicyOptions["store"] = {
    get: () => ({ mode: state.mode, allow: [...state.allow] }),
    entries: () => state.allow.map((text) => parseAllowlistEntry(text)),
    addAllow,
  };
  const policy = createNetworkPolicy({
    store,
    baseAllowlist: ["github.com", "*.npmjs.org"].map((text) => parseAllowlistEntry(text)),
    providers: options.providers ?? [],
    services: options.services,
    ask: { ask },
    onPersistError,
  });
  return {
    policy,
    ask,
    addAllow,
    onPersistError,
    setMode: (mode) => {
      state.mode = mode;
    },
  };
}

describe("createNetworkPolicy", () => {
  it("denies dns_error without asking when there are no addresses", async () => {
    const f = fixture();
    await expect(
      f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [] }),
    ).resolves.toEqual({
      decision: "deny",
      reason: "dns_error",
    });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("allows a provider IP literal even when internal, but not on another port", async () => {
    const providers: ProviderEndpoint[] = [{ provider: "ollama", host: PRIVATE_LAN, port: 11434 }];
    const f = fixture({ providers });
    await expect(
      f.policy({ host: PRIVATE_LAN, port: 11434, replica: REPLICA, addresses: [PRIVATE_LAN] }),
    ).resolves.toEqual({ decision: "allow", reason: "provider" });
    await expect(
      f.policy({ host: PRIVATE_LAN, port: 443, replica: REPLICA, addresses: [PRIVATE_LAN] }),
    ).resolves.toEqual({
      decision: "deny",
      reason: "internal_destination",
    });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("allows a provider by name when it resolves to an internal address", async () => {
    const providers: ProviderEndpoint[] = [{ provider: "ollama", host: "ollama.lan", port: 11434 }];
    const f = fixture({ providers });
    await expect(
      f.policy({ host: "ollama.lan", port: 11434, replica: REPLICA, addresses: [PRIVATE] }),
    ).resolves.toEqual({ decision: "allow", reason: "provider" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("allows a service endpoint on an internal address without asking, reason service", async () => {
    const services: ServiceEndpoint[] = [{ service: "web_search", host: "searxng", port: 8080 }];
    const f = fixture({ services });
    await expect(
      f.policy({ host: "searxng", port: 8080, replica: REPLICA, addresses: ["172.18.0.5"] }),
    ).resolves.toEqual({ decision: "allow", reason: "service" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("does not allow a service host on another port: it follows the normal policy", async () => {
    const services: ServiceEndpoint[] = [{ service: "web_search", host: "searxng", port: 8080 }];
    const f = fixture({ services });
    await expect(
      f.policy({ host: "searxng", port: 9090, replica: REPLICA, addresses: ["172.18.0.5"] }),
    ).resolves.toEqual({ decision: "deny", reason: "internal_destination" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("allows an external service endpoint on 443 in allowlist mode, reason service", async () => {
    const services: ServiceEndpoint[] = [
      { service: "notifications", host: "api.telegram.org", port: 443 },
    ];
    const f = fixture({ mode: "allowlist", services });
    await expect(
      f.policy({ host: "api.telegram.org", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
    ).resolves.toEqual({ decision: "allow", reason: "service" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("gives the provider reason priority when host and port are both a provider and a service", async () => {
    const providers: ProviderEndpoint[] = [{ provider: "ollama", host: PRIVATE_LAN, port: 11434 }];
    const services: ServiceEndpoint[] = [
      { service: "notifications", host: PRIVATE_LAN, port: 11434 },
    ];
    const f = fixture({ providers, services });
    await expect(
      f.policy({ host: PRIVATE_LAN, port: 11434, replica: REPLICA, addresses: [PRIVATE_LAN] }),
    ).resolves.toEqual({ decision: "allow", reason: "provider" });
  });

  it("allows a public allowlisted host without asking", async () => {
    const f = fixture();
    await expect(
      f.policy({ host: "github.com", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
    ).resolves.toEqual({
      decision: "allow",
      reason: "allowlist",
    });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("denies an allowlisted host that also resolves to a private address", async () => {
    const f = fixture();
    await expect(
      f.policy({ host: "github.com", port: 443, replica: REPLICA, addresses: [PUBLIC, PRIVATE] }),
    ).resolves.toEqual({ decision: "deny", reason: "internal_destination" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("matches a wildcard base entry", async () => {
    const f = fixture();
    await expect(
      f.policy({ host: "registry.npmjs.org", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
    ).resolves.toEqual({ decision: "allow", reason: "allowlist" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("matches an entry added with allow always", async () => {
    const f = fixture({ allow: ["example.org"] });
    await expect(
      f.policy({ host: "example.org", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
    ).resolves.toEqual({ decision: "allow", reason: "allowlist" });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("denies a disallowed port without asking", async () => {
    const f = fixture();
    await expect(
      f.policy({ host: "github.com", port: 22, replica: REPLICA, addresses: [PUBLIC] }),
    ).resolves.toEqual({
      decision: "deny",
      reason: "port_not_allowed",
    });
    expect(f.ask).not.toHaveBeenCalled();
  });

  describe("mode audit", () => {
    it("allows an external destination on an allowed port", async () => {
      const f = fixture({ mode: "audit" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({
        decision: "allow",
        reason: "audit",
      });
      expect(f.ask).not.toHaveBeenCalled();
    });

    it("denies a disallowed port", async () => {
      const f = fixture({ mode: "audit" });
      await expect(
        f.policy({ host: "unknown.dev", port: 8080, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "deny", reason: "port_not_allowed" });
    });

    it("denies an internal destination", async () => {
      const f = fixture({ mode: "audit" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PRIVATE] }),
      ).resolves.toEqual({ decision: "deny", reason: "internal_destination" });
    });
  });

  describe("mode allowlist", () => {
    it("denies an unlisted host with not_allowed, without asking", async () => {
      const f = fixture({ mode: "allowlist" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "deny", reason: "not_allowed" });
      expect(f.ask).not.toHaveBeenCalled();
    });
  });

  describe("mode ask", () => {
    it("asks on behalf of the replica of the input", async () => {
      const f = fixture({ answer: "deny" });
      await f.policy({ host: "unknown.dev", port: 443, addresses: [PUBLIC], replica: "agent-2" });
      expect(f.ask).toHaveBeenCalledWith("unknown.dev", 443, "agent-2");
    });

    it("allows once when the user answers allow_once", async () => {
      const f = fixture({ answer: "allow_once" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "allow", reason: "user_once" });
      expect(f.ask).toHaveBeenCalledWith("unknown.dev", 443, REPLICA);
      expect(f.addAllow).not.toHaveBeenCalled();
    });

    it("persists the host and allows when the user answers allow_always", async () => {
      const f = fixture({ answer: "allow_always" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "allow", reason: "user_always" });
      expect(f.addAllow).toHaveBeenCalledWith("unknown.dev");
      expect(f.onPersistError).not.toHaveBeenCalled();
    });

    it("still allows when persisting allow always fails and reports the error", async () => {
      const f = fixture({ answer: "allow_always" });
      const failure = new Error("disk full");
      f.addAllow.mockRejectedValueOnce(failure);
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "allow", reason: "user_always" });
      expect(f.onPersistError).toHaveBeenCalledWith(failure);
    });

    it("denies when the user answers deny", async () => {
      const f = fixture({ answer: "deny" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "deny", reason: "user_denied" });
    });

    it("denies with ask_timeout when nobody answers", async () => {
      const f = fixture({ answer: "timeout" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "deny", reason: "ask_timeout" });
    });

    it("denies with no_session when there is no session to ask", async () => {
      const f = fixture({ answer: "no_session" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "deny", reason: "no_session" });
    });

    it("reads the mode on every decision", async () => {
      const f = fixture({ mode: "allowlist", answer: "allow_once" });
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "deny", reason: "not_allowed" });
      f.setMode("ask");
      await expect(
        f.policy({ host: "unknown.dev", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "allow", reason: "user_once" });
      expect(f.ask).toHaveBeenCalledTimes(1);
    });

    it("normalizes the host to lowercase without a trailing dot", async () => {
      const f = fixture({ answer: "allow_once" });
      await expect(
        f.policy({ host: "Unknown.DEV.", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "allow", reason: "user_once" });
      expect(f.ask).toHaveBeenCalledWith("unknown.dev", 443, REPLICA);
      await expect(
        f.policy({ host: "GitHub.COM.", port: 443, replica: REPLICA, addresses: [PUBLIC] }),
      ).resolves.toEqual({ decision: "allow", reason: "allowlist" });
    });
  });
});

describe("createAuditPolicy", () => {
  const policy = createAuditPolicy();

  it("denies a disallowed port first, even when the address is internal", () => {
    expect(policy({ host: "x", port: 22, replica: REPLICA, addresses: ["10.0.0.1"] })).toEqual({
      decision: "deny",
      reason: "port_not_allowed",
    });
  });

  it("denies when there are no addresses", () => {
    expect(policy({ host: "x", port: 443, replica: REPLICA, addresses: [] })).toEqual({
      decision: "deny",
      reason: "dns_error",
    });
  });

  it("denies when any resolved address is internal", () => {
    expect(
      policy({ host: "x", port: 443, replica: REPLICA, addresses: ["140.82.112.3", "10.0.0.1"] }),
    ).toEqual({
      decision: "deny",
      reason: "internal_destination",
    });
  });

  it("allows external destinations on an allowed port as audit", () => {
    expect(
      policy({ host: "github.com", port: 443, replica: REPLICA, addresses: ["140.82.112.3"] }),
    ).toEqual({
      decision: "allow",
      reason: "audit",
    });
  });

  it("uses the allowedPorts option instead of the defaults", () => {
    const custom = createAuditPolicy({ allowedPorts: [8443] });
    expect(
      custom({ host: "x", port: 443, replica: REPLICA, addresses: ["140.82.112.3"] }).reason,
    ).toBe("port_not_allowed");
    expect(
      custom({ host: "x", port: 8443, replica: REPLICA, addresses: ["140.82.112.3"] }),
    ).toEqual({
      decision: "allow",
      reason: "audit",
    });
  });
});

describe("systemResolver", () => {
  it("returns IP literals as-is without DNS", async () => {
    await expect(systemResolver("1.2.3.4")).resolves.toEqual(["1.2.3.4"]);
    await expect(systemResolver("::1")).resolves.toEqual(["::1"]);
  });
});
