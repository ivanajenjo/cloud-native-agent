import {
  decodeQuestionTitle,
  type PiMessage,
  parseModeEntry,
  parseTodoDetails,
  type Question,
  type SessionEvent,
  TODO_TOOL_NAME,
  type TodoItem,
} from "@cna/shared";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

/** A raw Pi session event (any stdout record that is not a response nor a UI request). */
export type RpcEvent = { type: string } & Record<string, unknown>;

type Obj = Record<string, unknown>;

const COMPACTION_REASONS = ["manual", "threshold", "overflow"] as const;
type CompactionReason = (typeof COMPACTION_REASONS)[number];

const NOTIFY_LEVELS = ["info", "warning", "error"] as const;
type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompactionReason(value: unknown): value is CompactionReason {
  return (COMPACTION_REASONS as readonly unknown[]).includes(value);
}

function isNotifyLevel(value: unknown): value is NotifyLevel {
  return (NOTIFY_LEVELS as readonly unknown[]).includes(value);
}

/** Maps one Pi event to zero or more SSE events. Unknown or irrelevant events → []. Never throws on malformed input (missing fields → []). */
export function normalizeRpcEvent(event: RpcEvent): SessionEvent[] {
  if (!isObject(event)) {
    return [];
  }
  switch (event.type) {
    case "message_update":
      return normalizeMessageUpdate(event);

    case "message_end": {
      const { message } = event;
      if (!isObject(message) || typeof message.role !== "string") {
        return [];
      }
      return [{ type: "message", message: message as PiMessage }];
    }

    case "tool_execution_start": {
      if (!hasToolIds(event)) {
        return [];
      }
      return [
        {
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? null,
        },
      ];
    }

    case "tool_execution_update": {
      if (!hasToolIds(event)) {
        return [];
      }
      return [
        {
          type: "tool_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult ?? null,
        },
      ];
    }

    case "tool_execution_end": {
      if (!hasToolIds(event)) {
        return [];
      }
      const toolEnd: SessionEvent = {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result ?? null,
        isError: event.isError === true,
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
      };
      const todos = todoOfToolEnd(event);
      return todos === null ? [toolEnd] : [toolEnd, { type: "todo", todos }];
    }

    case "compaction_start": {
      if (!isCompactionReason(event.reason)) {
        return [];
      }
      return [{ type: "compaction", phase: "start", reason: event.reason }];
    }

    case "compaction_end": {
      if (!isCompactionReason(event.reason)) {
        return [];
      }
      return [
        {
          type: "compaction",
          phase: "end",
          reason: event.reason,
          aborted: event.aborted === true,
          ...(typeof event.errorMessage === "string" ? { error: event.errorMessage } : {}),
        },
      ];
    }

    case "auto_retry_start": {
      if (typeof event.attempt !== "number") {
        return [];
      }
      return [
        {
          type: "retry",
          phase: "start",
          attempt: event.attempt,
          ...(typeof event.maxAttempts === "number" ? { maxAttempts: event.maxAttempts } : {}),
          ...(typeof event.delayMs === "number" ? { delayMs: event.delayMs } : {}),
          ...(typeof event.errorMessage === "string" ? { error: event.errorMessage } : {}),
        },
      ];
    }

    case "auto_retry_end": {
      if (typeof event.attempt !== "number") {
        return [];
      }
      return [
        {
          type: "retry",
          phase: "end",
          attempt: event.attempt,
          success: event.success === true,
          ...(typeof event.finalError === "string" ? { error: event.finalError } : {}),
        },
      ];
    }

    case "extension_error": {
      // The extension path is deliberately left out of the message.
      if (typeof event.error !== "string") {
        return [];
      }
      return [{ type: "error", message: `extension error: ${event.error}` }];
    }

    case "entry_appended": {
      const mode = parseModeEntry(event.entry);
      return mode === null ? [] : [{ type: "mode", mode }];
    }

    default:
      // agent_start/agent_end/agent_settled, turn_*, message_start, queue_update...
      // The run state belongs to the SessionManager, not to these events.
      return [];
  }
}

function normalizeMessageUpdate(event: Obj): SessionEvent[] {
  const inner = event.assistantMessageEvent;
  if (!isObject(inner)) {
    return [];
  }
  const { contentIndex, delta } = inner;
  if (typeof contentIndex !== "number" || typeof delta !== "string") {
    return [];
  }
  switch (inner.type) {
    case "text_delta":
      return [{ type: "message_delta", contentIndex, delta }];
    case "thinking_delta":
      return [{ type: "thinking_delta", contentIndex, delta }];
    default:
      return [];
  }
}

/** Task list of a successful `todo` call with valid details; null otherwise. */
function todoOfToolEnd(event: Obj): TodoItem[] | null {
  if (event.toolName !== TODO_TOOL_NAME || event.isError === true) {
    return null;
  }
  const result = isObject(event.result) ? event.result : undefined;
  return parseTodoDetails(result?.details);
}

function hasToolIds(event: Obj): event is Obj & { toolCallId: string; toolName: string } {
  return typeof event.toolCallId === "string" && typeof event.toolName === "string";
}

/** Dialog UI requests (select/confirm/input/editor) → Question; others → null. now() gives createdAt (ISO). */
export function uiRequestToQuestion(request: RpcExtensionUIRequest, now: Date): Question | null {
  // Only dialog methods carry a title; fire-and-forget methods return null below.
  if (!("title" in request) || typeof request.title !== "string") {
    return null;
  }
  const { kind, title } = decodeQuestionTitle(request.title);
  const base = { id: request.id, kind, title, createdAt: now.toISOString() };
  const timeout =
    "timeout" in request && typeof request.timeout === "number"
      ? { timeoutMs: request.timeout }
      : {};

  switch (request.method) {
    case "select":
      return {
        ...base,
        method: "select",
        ...(Array.isArray(request.options)
          ? {
              options: request.options.filter(
                (option): option is string => typeof option === "string",
              ),
            }
          : {}),
        ...timeout,
      };

    case "confirm":
      return {
        ...base,
        method: "confirm",
        ...(typeof request.message === "string" ? { message: request.message } : {}),
        ...timeout,
      };

    case "input":
      return {
        ...base,
        method: "input",
        ...(typeof request.placeholder === "string" ? { placeholder: request.placeholder } : {}),
        ...timeout,
      };

    case "editor":
      return {
        ...base,
        method: "editor",
        ...(typeof request.prefill === "string" ? { prefill: request.prefill } : {}),
      };

    default:
      // notify, setStatus, setWidget, setTitle, set_editor_text: no answer expected.
      return null;
  }
}

/** `notify` → { type:"notify", level: notifyType ?? "info", message }; any other method → null. */
export function uiRequestToNotify(request: RpcExtensionUIRequest): SessionEvent | null {
  if (request.method !== "notify" || typeof request.message !== "string") {
    return null;
  }
  const level = isNotifyLevel(request.notifyType) ? request.notifyType : "info";
  return { type: "notify", level, message: request.message };
}
