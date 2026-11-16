import { z } from "zod";

/**
 * Checkpoints (feature 4) and diff (feature 3). The gateway snapshots the working tree, untracked
 * files included and ignored files excluded, in `refs/cna/checkpoints/<id>` (ADR-0007).
 */

export interface Checkpoint {
  /** 0 for the snapshot taken right after cloning; then 1, 2, ... */
  id: number;
  /** Full sha of the snapshot commit. */
  commit: string;
  /** ISO 8601. */
  createdAt: string;
  /** `start`: after cloning. `run`: at the end of a run (`agent_settled`) that changed files. */
  reason: "start" | "run";
}

/** Body of `GET /session/checkpoints`, oldest first. */
export interface CheckpointsResponse {
  checkpoints: Checkpoint[];
}

/** Body of `POST /session/checkpoints/:id/restore`. Default: files only. */
export const RestoreCheckpointRequestSchema = z
  .object({ conversation: z.boolean().optional() })
  .strict();
export type RestoreCheckpointRequest = z.infer<typeof RestoreCheckpointRequestSchema>;

/** Response of `POST /session/checkpoints/:id/restore` (200). */
export interface RestoreCheckpointResponse {
  checkpoint: Checkpoint;
  /** True if the conversation was also moved back (Pi `fork`). */
  conversationRestored: boolean;
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  /** `renamed` only. */
  oldPath?: string;
  status: DiffFileStatus;
  /** null for binary files. */
  additions: number | null;
  deletions: number | null;
}

/** What `GET /session/diff` compares the current working tree against. */
export type DiffSource =
  | { kind: "base"; branch: string; commit: string }
  | { kind: "checkpoint"; id: number; commit: string };

/** Body of `GET /session/diff[?checkpoint=<id>]`. */
export interface DiffResponse {
  from: DiffSource;
  files: DiffFile[];
  /** Unified diff (`git diff`), cut at DIFF_PATCH_MAX_BYTES. */
  patch: string;
  /** True when `patch` was cut. `files` is always complete. */
  truncated: boolean;
}

export const DIFF_PATCH_MAX_BYTES = 1024 * 1024;

/** Value of `?checkpoint=`: a non-negative decimal integer without sign or leading zeros. */
export function parseCheckpointId(value: string): number | null {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) {
    return null;
  }
  return Number(value);
}
