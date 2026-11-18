import type { ReplicaSummary, SessionInfo, SessionStatus } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { replicaOptionLabel, replicaStateLabel } from "../src/views/replicas-format.js";

function session(status: SessionStatus, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "session-1",
    status,
    repo: "owner/repo",
    baseBranch: "main",
    branch: "agent/fix-bug",
    model: null,
    thinking: null,
    mode: "auto",
    autoPush: false,
    createdAt: "2026-11-18T10:00:00.000Z",
    pr: null,
    suspended: false,
    pendingQuestions: [],
    ...overrides,
  };
}

function replica(
  name: string,
  reachable: boolean,
  sessionInfo: SessionInfo | null,
): ReplicaSummary {
  return { name, reachable, session: sessionInfo };
}

describe("replicaStateLabel", () => {
  it("is 'sin conexión' when the replica is unreachable", () => {
    expect(replicaStateLabel(replica("agent-3", false, null))).toBe("sin conexión");
  });

  it("is 'libre' when there is no session", () => {
    expect(replicaStateLabel(replica("agent-1", true, null))).toBe("libre");
  });

  it("is 'libre' when the session is closed", () => {
    expect(replicaStateLabel(replica("agent-1", true, session("closed")))).toBe("libre");
  });

  it("is the status label of a running session", () => {
    expect(replicaStateLabel(replica("agent-2", true, session("running")))).toBe("trabajando");
  });

  it("is the status label of a session waiting for input", () => {
    expect(replicaStateLabel(replica("agent-2", true, session("waiting_input")))).toBe(
      "esperando respuesta",
    );
  });

  it("is the status label of a session in error", () => {
    expect(replicaStateLabel(replica("agent-2", true, session("error")))).toBe("error");
  });
});

describe("replicaOptionLabel", () => {
  it("labels a free default replica", () => {
    expect(replicaOptionLabel(replica("agent-1", true, null), true)).toBe(
      "agent-1 (por defecto) · libre",
    );
  });

  it("labels a running session with its repo", () => {
    expect(replicaOptionLabel(replica("agent-2", true, session("running")), false)).toBe(
      "agent-2 · trabajando · owner/repo",
    );
  });

  it("labels a ready session with its repo and PR", () => {
    expect(replicaOptionLabel(replica("agent-2", true, session("ready", { pr: 7 })), false)).toBe(
      "agent-2 · lista · owner/repo PR #7",
    );
  });

  it("labels an unreachable replica without a session part", () => {
    expect(replicaOptionLabel(replica("agent-3", false, null), false)).toBe(
      "agent-3 · sin conexión",
    );
  });

  it("labels an errored session with its repo", () => {
    expect(replicaOptionLabel(replica("agent-2", true, session("error")), false)).toBe(
      "agent-2 · error · owner/repo",
    );
  });

  it("omits the session part of a closed session", () => {
    expect(replicaOptionLabel(replica("agent-2", true, session("closed")), false)).toBe(
      "agent-2 · libre",
    );
  });
});
