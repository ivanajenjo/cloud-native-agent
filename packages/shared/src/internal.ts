import { z } from "zod";
import { NETWORK_DECISION_REASONS, type NetworkLogEntry } from "./network.js";
import type { Question, QuestionOutcome } from "./questions.js";

/**
 * Internal edge → gateway contract (ADR-0008). Only reachable on the internal network;
 * edge never forwards `/internal/*` from its public entry.
 */
export const INTERNAL_PATH_PREFIX = "/internal/";

export const INTERNAL_ROUTES = {
  /** POST {@link PublishQuestionRequest} → 201, or 409 `{error:"no_session"}`. */
  questions: "/internal/questions",
  /** POST {@link ResolveQuestionRequest} to `/internal/questions/:id/resolved` → 204 or 404. */
  questionResolved: (id: string) => `/internal/questions/${encodeURIComponent(id)}/resolved`,
  /** POST {@link PublishNetworkEntryRequest} → 204. */
  network: "/internal/network",
} as const;

export interface PublishQuestionRequest {
  question: Question;
}

export interface ResolveQuestionRequest {
  outcome: QuestionOutcome;
}

export interface PublishNetworkEntryRequest {
  entry: NetworkLogEntry;
}

/** Validation of the internal bodies, used by the gateway. */
export const PublishQuestionRequestSchema = z
  .object({
    question: z
      .object({
        id: z.string().startsWith("net-"),
        kind: z.literal("network"),
        method: z.literal("select"),
        title: z.string(),
        options: z.array(z.string()),
        timeoutMs: z.number().int().positive().optional(),
        createdAt: z.string(),
        network: z.object({ host: z.string(), port: z.number().int() }).strict(),
      })
      .strict(),
  })
  .strict();

export const ResolveQuestionRequestSchema = z
  .object({ outcome: z.enum(["answered", "cancelled", "timeout"]) })
  .strict();

export const PublishNetworkEntryRequestSchema = z
  .object({
    entry: z
      .object({
        ts: z.string(),
        method: z.enum(["CONNECT", "HTTP"]),
        host: z.string(),
        port: z.number().int(),
        decision: z.enum(["allow", "deny"]),
        reason: z.enum(NETWORK_DECISION_REASONS),
        bytesOut: z.number(),
        bytesIn: z.number(),
        durationMs: z.number(),
        error: z.string().optional(),
      })
      .strict(),
  })
  .strict();
