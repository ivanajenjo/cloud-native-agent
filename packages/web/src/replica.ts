import type { ReplicaSummary } from "@cna/shared";
import { isReplicaName, replicaBasePath } from "@cna/shared/client";

/** Pure replica selection helpers (ADR-0013). No DOM here. */

const HASH_PREFIX = "replica=";

/** `#replica=<name>` (with or without the leading "#") → name. Anything else → null: empty hash, other keys, extra parameters, a name that is not valid per isReplicaName, or a percent-encoded value. */
export function replicaFromHash(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body.startsWith(HASH_PREFIX)) {
    return null;
  }
  const name = body.slice(HASH_PREFIX.length);
  return isReplicaName(name) ? name : null;
}

/** null → "" ; name → "#replica=<name>". */
export function replicaHash(name: string | null): string {
  return name === null ? "" : `#${HASH_PREFIX}${name}`;
}

/** Base URL for the ApiClient of the selected replica: null → "" (default replica, unprefixed same-origin paths); name → replicaBasePath(name), e.g. "/replicas/agent-2". */
export function replicaBaseUrl(name: string | null): string {
  return name === null ? "" : replicaBasePath(name);
}

/** Name of the replica shown as current: the one in the hash, or else the first (default) of the list; null when the hash is null and the list is empty. */
export function currentReplicaName(
  hashReplica: string | null,
  replicas: readonly ReplicaSummary[],
): string | null {
  if (hashReplica !== null) {
    return hashReplica;
  }
  return replicas[0]?.name ?? null;
}
