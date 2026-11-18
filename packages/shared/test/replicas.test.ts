import { describe, expect, it } from "vitest";
import {
  freeReplicaNames,
  isReplicaFree,
  parseReplicaNames,
  type ReplicaSummary,
  replicaBasePath,
} from "../src/replicas.js";
import type { SessionInfo } from "../src/session.js";

function withStatus(status: SessionInfo["status"]): SessionInfo {
  return { status } as SessionInfo;
}

function replica(
  name: string,
  reachable: boolean,
  session: SessionInfo | null = null,
): ReplicaSummary {
  return { name, reachable, session };
}

describe("parseReplicaNames", () => {
  it("parses one name", () => {
    expect(parseReplicaNames("agent-1")).toEqual(["agent-1"]);
  });

  it("ignores spaces around each name", () => {
    expect(parseReplicaNames(" agent-1 , agent-2 ")).toEqual(["agent-1", "agent-2"]);
  });

  it("keeps the order of the names", () => {
    expect(parseReplicaNames("agent-3,agent-1,agent-2")).toEqual(["agent-3", "agent-1", "agent-2"]);
  });

  it.each([
    ["an empty string", ""],
    ["an empty item at the end", "agent-1,"],
    ["an empty item in the middle", "agent-1,,agent-2"],
    ["a repeated name", "agent-1,agent-1"],
    ["an uppercase name", "Agent-1"],
    ["a name starting with '-'", "-a"],
    ["a name ending with '-'", "a-"],
    ["a name of 64 characters", "a".repeat(64)],
    ["a name with '_'", "a_b"],
    ["a name with '.'", "a.b"],
    ["a name with '/'", "a/b"],
    ["a name with an escaped slash", "a%2f"],
  ])("throws for %s", (_label, value) => {
    expect(() => parseReplicaNames(value)).toThrow(Error);
  });

  it("accepts a name of 63 characters", () => {
    const name = "a".repeat(63);
    expect(parseReplicaNames(name)).toEqual([name]);
  });

  it("accepts 16 names", () => {
    const names = Array.from({ length: 16 }, (_, index) => `agent-${index + 1}`);
    expect(parseReplicaNames(names.join(","))).toEqual(names);
  });

  it("throws for 17 names", () => {
    const names = Array.from({ length: 17 }, (_, index) => `agent-${index + 1}`);
    expect(() => parseReplicaNames(names.join(","))).toThrow(Error);
  });
});

describe("replicaBasePath", () => {
  it("returns the path prefix of one replica", () => {
    expect(replicaBasePath("agent-2")).toBe("/replicas/agent-2");
  });
});

describe("isReplicaFree", () => {
  it("is false when the replica is not reachable, even without session", () => {
    expect(isReplicaFree(replica("agent-1", false, null))).toBe(false);
  });

  it("is true when reachable without session", () => {
    expect(isReplicaFree(replica("agent-1", true, null))).toBe(true);
  });

  it.each(["closed", "error"] as const)("is true when the session is %s", (status) => {
    expect(isReplicaFree(replica("agent-1", true, withStatus(status)))).toBe(true);
  });

  it.each(["running", "ready", "cloning", "waiting_input", "idle"] as const)(
    "is false when the session is %s",
    (status) => {
      expect(isReplicaFree(replica("agent-1", true, withStatus(status)))).toBe(false);
    },
  );
});

describe("freeReplicaNames", () => {
  it("keeps the order of edge", () => {
    const replicas = [
      replica("agent-3", true, null),
      replica("agent-1", true, withStatus("running")),
      replica("agent-2", false, null),
      replica("agent-4", true, withStatus("closed")),
    ];
    expect(freeReplicaNames(replicas)).toEqual(["agent-3", "agent-4"]);
  });

  it("returns an empty list without replicas", () => {
    expect(freeReplicaNames([])).toEqual([]);
  });
});
