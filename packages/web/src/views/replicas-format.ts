import type { ReplicaSummary } from "@cna/shared";
import { statusLabel } from "./format.js";

/** Pure presentation helpers of the replica selector and the replicas view. No DOM here. */

/** Spanish state of a replica: unreachable → "sin conexión"; free with no session or a "closed" session → "libre"; otherwise statusLabel(session.status) from ./format.js (e.g. "trabajando", "error"). */
export function replicaStateLabel(replica: ReplicaSummary): string {
  if (!replica.reachable) {
    return "sin conexión";
  }
  const { session } = replica;
  if (session === null || session.status === "closed") {
    return "libre";
  }
  return statusLabel(session.status);
}

/** One-line label for the replica selector: "<name>" + (isDefault ? " (por defecto)" : "") + " · " + replicaStateLabel + (a session that is not "closed" ? " · " + repo + (pr === null ? "" : " PR #" + pr) : ""). */
export function replicaOptionLabel(replica: ReplicaSummary, isDefault: boolean): string {
  let label = replica.name;
  if (isDefault) {
    label += " (por defecto)";
  }
  label += ` · ${replicaStateLabel(replica)}`;
  const { session } = replica;
  if (session !== null && session.status !== "closed") {
    label += ` · ${session.repo}`;
    if (session.pr !== null) {
      label += ` PR #${session.pr}`;
    }
  }
  return label;
}
