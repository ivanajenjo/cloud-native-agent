import type { NetworkLogEntry } from "./network.js";
import type { Question, QuestionOutcome } from "./questions.js";
import type { PiMessage, SessionStatus } from "./session.js";

/**
 * Events of `GET /session/events`, normalized from Pi's RPC events and from edge.
 * On the wire each one is an SSE record with `id: <seq>`, `event: <type>` and
 * `data: <JSON of the StreamEvent>`.
 */
export type SessionEvent =
  | { type: "status"; status: SessionStatus; error?: string }
  /** `message_update` text_delta of the assistant message being streamed. */
  | { type: "message_delta"; contentIndex: number; delta: string }
  /** `message_update` thinking_delta. */
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  /** `message_end`: the authoritative final message. */
  | { type: "message"; message: PiMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
    }
  | { type: "question"; question: Question }
  | { type: "question_resolved"; questionId: string; outcome: QuestionOutcome }
  | { type: "network"; entry: NetworkLogEntry }
  | {
      type: "compaction";
      phase: "start" | "end";
      reason: "manual" | "threshold" | "overflow";
      aborted?: boolean;
      error?: string;
    }
  | {
      type: "retry";
      phase: "start" | "end";
      attempt: number;
      maxAttempts?: number;
      delayMs?: number;
      success?: boolean;
      error?: string;
    }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  | { type: "error"; message: string };

export type SessionEventType = SessionEvent["type"];

/** What the SSE `data:` field carries. */
export interface StreamEvent {
  /** Monotonic per gateway process, starting at 1. Also the SSE `id:`. */
  id: number;
  /** ISO 8601. */
  ts: string;
  event: SessionEvent;
}
