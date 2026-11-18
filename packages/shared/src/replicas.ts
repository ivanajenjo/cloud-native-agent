import type { SessionInfo } from "./session.js";

/**
 * Several agent replicas behind one shared edge (ADR-0012). Each replica is an agent container
 * (gateway + Pi) on its own internal network; edge is on all of them.
 */

/**
 * Replica name: also the agent container's hostname on its network (`agent-1`, `agent-2`…).
 * Lowercase letters, digits and `-`, 1 to 63 characters, no leading or trailing `-`.
 */
export const REPLICA_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Most replicas edge accepts in `EDGE_REPLICAS`. */
export const MAX_REPLICAS = 16;

/** `GET /replicas`, answered by edge: every configured replica and its session. */
export const REPLICAS_PATH = "/replicas";

/** `/replicas/<name>/<rest>` is forwarded to that replica as `/<rest>`. */
export const REPLICA_PATH_PREFIX = "/replicas/";

/** Path prefix that addresses one replica through edge, e.g. `/replicas/agent-2`. */
export function replicaBasePath(name: string): string {
  return `${REPLICA_PATH_PREFIX}${name}`;
}

/** True if `name` is a valid replica name (see {@link REPLICA_NAME_PATTERN}). */
export function isReplicaName(name: string): boolean {
  return REPLICA_NAME_PATTERN.test(name);
}

/**
 * Parses a comma-separated list of replica names (`EDGE_REPLICAS`). Spaces around each name
 * are ignored. Throws an `Error` if the list is empty, has an empty item, an invalid or
 * repeated name, or more than {@link MAX_REPLICAS} names. Order is kept: the first one is the
 * default replica (paths without the `/replicas/<name>` prefix go to it).
 */
export function parseReplicaNames(value: string): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.length === 1 && names[0] === "") {
    throw new Error("expected at least one replica name");
  }
  if (names.length > MAX_REPLICAS) {
    throw new Error(`at most ${MAX_REPLICAS} replicas are supported`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (name === "") {
      throw new Error("empty replica name");
    }
    if (!isReplicaName(name)) {
      throw new Error(
        "invalid replica name: use lowercase letters, digits and '-' (at most 63 characters)",
      );
    }
    if (seen.has(name)) {
      throw new Error(`repeated replica name: ${name}`);
    }
    seen.add(name);
  }
  return names;
}

/** One entry of `GET /replicas`. */
export interface ReplicaSummary {
  name: string;
  /** false when its gateway did not answer `GET /session` with 200 or 404 in time. */
  reachable: boolean;
  /** Its current session; null when it has none (404) or is unreachable. */
  session: SessionInfo | null;
}

/** Body of `GET /replicas`, in `EDGE_REPLICAS` order (the first one is the default replica). */
export interface ReplicasResponse {
  replicas: ReplicaSummary[];
}

/**
 * True when the replica can take a new session (ADR-0013): reachable, and with no session or
 * with one whose status is "closed" or "error" (the gateway then accepts `POST /session`).
 */
export function isReplicaFree(replica: ReplicaSummary): boolean {
  if (!replica.reachable) {
    return false;
  }
  const { session } = replica;
  return session === null || session.status === "closed" || session.status === "error";
}

/** Names of the free replicas ({@link isReplicaFree}), in edge's order. */
export function freeReplicaNames(replicas: readonly ReplicaSummary[]): string[] {
  return replicas.filter(isReplicaFree).map((replica) => replica.name);
}
