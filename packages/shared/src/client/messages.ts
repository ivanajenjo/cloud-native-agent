/**
 * Presentation helpers for Pi messages (see Pi's docs/message-types.md). They accept any value
 * at runtime and never throw.
 */
import type { PiMessage } from "../session.js";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The content blocks of a message, or [] when content is not an array. */
function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

/** Concatenation (joined with "") of the text blocks, or the string content. "" if none. Never throws. */
export function messageText(message: PiMessage): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  return contentBlocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** Concatenation of thinking blocks. "" if none. */
export function messageThinking(message: PiMessage): string {
  return contentBlocks(message)
    .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking as string)
    .join("");
}

/** toolCall blocks of an assistant message, in order. Blocks without string id/name are skipped. */
export function messageToolCalls(message: PiMessage): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type !== "toolCall") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string") continue;
    calls.push({ id: block.id, name: block.name, arguments: block.arguments });
  }
  return calls;
}

/**
 * Text of a tool result (`result` of the SSE `tool_end`, `partialResult` of `tool_update`):
 * if it is an object with a `content` array, the text blocks joined with "\n"; if it is a string, itself;
 * otherwise "". Never throws.
 */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
