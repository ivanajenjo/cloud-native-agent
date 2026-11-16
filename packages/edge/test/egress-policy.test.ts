import { describe, expect, it } from "vitest";
import { createAuditPolicy, systemResolver } from "../src/egress/policy.js";

describe("createAuditPolicy", () => {
  const policy = createAuditPolicy();

  it("denies a disallowed port first, even when the address is internal", () => {
    expect(policy({ host: "x", port: 22, addresses: ["10.0.0.1"] })).toEqual({
      decision: "deny",
      reason: "port_not_allowed",
    });
  });

  it("denies when there are no addresses", () => {
    expect(policy({ host: "x", port: 443, addresses: [] })).toEqual({
      decision: "deny",
      reason: "dns_error",
    });
  });

  it("denies when any resolved address is internal", () => {
    expect(policy({ host: "x", port: 443, addresses: ["140.82.112.3", "10.0.0.1"] })).toEqual({
      decision: "deny",
      reason: "internal_destination",
    });
  });

  it("allows external destinations on an allowed port as audit", () => {
    expect(policy({ host: "github.com", port: 443, addresses: ["140.82.112.3"] })).toEqual({
      decision: "allow",
      reason: "audit",
    });
  });

  it("uses the allowedPorts option instead of the defaults", () => {
    const custom = createAuditPolicy({ allowedPorts: [8443] });
    expect(custom({ host: "x", port: 443, addresses: ["140.82.112.3"] }).reason).toBe(
      "port_not_allowed",
    );
    expect(custom({ host: "x", port: 8443, addresses: ["140.82.112.3"] })).toEqual({
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
