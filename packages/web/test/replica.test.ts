import type { ReplicaSummary } from "@cna/shared";
import { describe, expect, it } from "vitest";
import {
  currentReplicaName,
  replicaBaseUrl,
  replicaFromHash,
  replicaHash,
} from "../src/replica.js";

function replica(name: string): ReplicaSummary {
  return { name, reachable: true, session: null };
}

describe("replicaFromHash", () => {
  it.each([
    ["#replica=agent-2", "agent-2"],
    ["replica=agent-2", "agent-2"],
    ["", null],
    ["#", null],
    ["#replica=", null],
    ["#replica=Agent-2", null],
    ["#replica=agent_2", null],
    ["#replica=agent-2&x=1", null],
    ["#other=agent-2", null],
    ["#replica=agent%2D2", null],
    ["#replica=-a", null],
  ])("parses %j as %s", (hash, expected) => {
    expect(replicaFromHash(hash)).toBe(expected);
  });
});

describe("replicaHash", () => {
  it("returns an empty string for null", () => {
    expect(replicaHash(null)).toBe("");
  });

  it("returns the fragment for a name", () => {
    expect(replicaHash("agent-2")).toBe("#replica=agent-2");
  });

  it("round-trips through replicaFromHash", () => {
    expect(replicaFromHash(replicaHash("agent-2"))).toBe("agent-2");
  });
});

describe("replicaBaseUrl", () => {
  it("returns an empty string for the default replica", () => {
    expect(replicaBaseUrl(null)).toBe("");
  });

  it("returns the prefixed path of a named replica", () => {
    expect(replicaBaseUrl("agent-2")).toBe("/replicas/agent-2");
  });
});

describe("currentReplicaName", () => {
  it("returns the replica of the hash", () => {
    expect(currentReplicaName("agent-2", [replica("agent-1"), replica("agent-2")])).toBe("agent-2");
  });

  it("returns the first replica of the list when the hash is null", () => {
    expect(currentReplicaName(null, [replica("agent-1"), replica("agent-2")])).toBe("agent-1");
  });

  it("returns null when the hash is null and the list is empty", () => {
    expect(currentReplicaName(null, [])).toBeNull();
  });
});
