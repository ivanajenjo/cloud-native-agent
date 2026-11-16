import { z } from "zod";
import type { Question } from "./questions.js";

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

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

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
    prompt: z.string().min(1),
    model: ModelRefSchema.optional(),
    thinking: ThinkingLevelSchema.optional(),
    /** Default "auto". "plan": read-only until the user approves a plan (`question{kind:"plan"}`). */
    mode: SessionModeSchema.optional(),
    autoPush: z.boolean().optional(),
  })
  .strict();
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
  | "unauthorized"
  | "bad_gateway"
  | "internal_error";

export interface ApiError {
  error: ApiErrorCode;
  message?: string;
}
