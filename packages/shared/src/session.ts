import { z } from "zod";
import type { Question } from "./questions.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.js";

/** Session lifecycle: idle → cloning → running ⇄ waiting_input → ready → closed (+ error). */
export const SESSION_STATUSES = [
  "idle",
  "cloning",
  "running",
  "waiting_input",
  "ready",
  "closed",
  "error",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses in which edge may publish network questions (ADR-0008). */
export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = [
  "cloning",
  "running",
  "waiting_input",
  "ready",
];

export { THINKING_LEVELS, type ThinkingLevel };
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

export const SessionModeSchema = z.enum(["plan", "auto"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/** GitHub `owner/name`. Names `.` and `..` are rejected separately. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `provider/model-id`; the model id may itself contain `/` and `:`. */
const MODEL_REF_PATTERN = /^[A-Za-z0-9._-]+\/\S+$/;

export const ModelRefSchema = z.string().regex(MODEL_REF_PATTERN, "expected provider/model");

export const CreateSessionRequestSchema = z
  .object({
    repo: z
      .string()
      .regex(REPO_PATTERN, "expected a GitHub repository as owner/name")
      .refine((value) => !/\/\.{1,2}$/.test(value), "invalid repository name"),
    /** Validated as a git branch name by the gateway. Default: the remote's default branch. */
    baseBranch: z.string().min(1).max(200).optional(),
    /** Required unless `pr` is set: then the gateway adds the PR instructions (ADR-0011). */
    prompt: z.string().min(1).optional(),
    /**
     * Work on an existing pull request of `repo` instead of a new agent/<slug> branch (feature 7).
     * Only open PRs from the same repository whose head branch is `agent/*` (ADR-0011).
     */
    pr: z.number().int().min(1).max(1_000_000_000).optional(),
    model: ModelRefSchema.optional(),
    thinking: ThinkingLevelSchema.optional(),
    /** Default "auto". "plan": read-only until the user approves a plan (`question{kind:"plan"}`). */
    mode: SessionModeSchema.optional(),
    autoPush: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.prompt !== undefined || body.pr !== undefined, {
    message: "prompt is required unless pr is set",
    path: ["prompt"],
  });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const PostMessageRequestSchema = z
  .object({
    text: z.string().min(1),
    /** Required by Pi while it is streaming; ignored when idle. Default "followUp". */
    mode: z.enum(["steer", "followUp"]).optional(),
  })
  .strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

/** Pi's `data.disposition` of a `prompt` command. */
export type PromptDisposition = "started" | "queued" | "handled";

export interface PostMessageResponse {
  disposition: PromptDisposition;
}

export const AnswerRequestSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

export const SetModelRequestSchema = z
  .object({
    model: ModelRefSchema,
    thinking: ThinkingLevelSchema.optional(),
  })
  .strict();
export type SetModelRequest = z.infer<typeof SetModelRequestSchema>;

/** Body of `GET /session` and of `POST /session` (201). */
export interface SessionInfo {
  id: string;
  status: SessionStatus;
  repo: string;
  baseBranch: string | null;
  /** `agent/<slug>`; null until the branch is created. */
  branch: string | null;
  /** `provider/model-id`, or null if Pi chose its default. */
  model: string | null;
  thinking: ThinkingLevel | null;
  mode: SessionMode;
  autoPush: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** Pull request the session works on (feature 7), or null for a new agent/<slug> branch. */
  pr: number | null;
  /**
   * True while Pi is stopped to save memory (inactivity, or after a gateway restart): the session
   * keeps its state and Pi starts again, resuming the conversation, on the next request that needs it.
   */
  suspended: boolean;
  /** Reason of the `error` status. */
  error?: string;
  pendingQuestions: Question[];
}

/** One entry of `GET /models`. */
export interface ModelInfo {
  /** `provider/model-id`. */
  ref: string;
  provider: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
}

export interface ModelsResponse {
  default: string | null;
  models: ModelInfo[];
}

/**
 * A message as Pi emits it (`AgentMessage`, see Pi's docs/message-types.md). The gateway
 * passes it through after redacting secrets.
 */
export type PiMessage = { role: string } & Record<string, unknown>;

export interface MessagesResponse {
  messages: PiMessage[];
}

/** Error codes of the API. Body: `{ error, message? }`. */
export type ApiErrorCode =
  | "invalid_request"
  | "not_found"
  | "no_session"
  | "session_exists"
  | "invalid_state"
  | "question_not_found"
  | "question_resolved"
  | "checkpoint_not_found"
  | "mode_not_supported"
  | "unknown_model"
  | "history_not_found"
  | "unauthorized"
  | "bad_gateway"
  | "internal_error";

export interface ApiError {
  error: ApiErrorCode;
  message?: string;
}

/**
 * Body of `GET /session/stats` (feature 9), from Pi's `get_session_stats`. Tokens and cost cover the
 * whole conversation, also before a gateway restart (Pi keeps them in its session file).
 */
export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** In the provider's currency (USD for the built-in providers); 0 when the model has no price. */
  cost: number;
  messages: { user: number; assistant: number; toolCalls: number };
  /** Current context window usage; null when Pi does not know it. `tokens`/`percent` are null right after a compaction. */
  context: { tokens: number | null; window: number; percent: number | null } | null;
}
