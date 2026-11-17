import { z } from "zod";
import type { SessionMode, SessionStats, SessionStatus } from "./session.js";

/** Sessions kept in the history of a replica (feature 10). Older ones are dropped with their Pi file. */
export const HISTORY_LIMIT = 50;

/** One past (or the current) session of this replica, as kept in the gateway's history (ADR-0011). */
export interface HistoryEntry {
  /** Same id as SessionInfo.id and as Pi's session id. */
  id: string;
  repo: string;
  baseBranch: string | null;
  branch: string | null;
  pr: number | null;
  mode: SessionMode;
  model: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601; null for the current session. */
  closedAt: string | null;
  /** Last known status ("closed" once closed). */
  status: SessionStatus;
  /** Last known token usage and cost; null if never read. */
  stats: SessionStats | null;
  /** Closed, with a branch, and Pi's session file still on disk: `POST /session/history/:id/resume` works. */
  resumable: boolean;
}

/** Body of `GET /session/history`: newest first, at most HISTORY_LIMIT. */
export interface HistoryResponse {
  sessions: HistoryEntry[];
}

/** Body of `POST /session/history/:id/resume`. Without prompt the session waits in `ready`. */
export const ResumeSessionRequestSchema = z
  .object({ prompt: z.string().min(1).optional() })
  .strict();
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;
