import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Redactor } from "../redact.js";

/** One line of /data/logs/tools.jsonl: a finished tool execution. */
export interface ToolLogEntry {
  /** ISO 8601, when the tool finished. */
  ts: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Arguments from tool_execution_start; null if the start was not seen. */
  args: unknown;
  isError: boolean;
  durationMs?: number;
  /** Text parts of the result joined with "\n", cut at MAX_RESULT_CHARS. */
  result: string;
}

export const MAX_RESULT_CHARS = 2000;
export const MAX_ARGS_CHARS = 4000;
/** Max starts waiting for their end. The oldest is dropped when the limit is reached. */
export const MAX_PENDING = 1000;

export interface ToolLog {
  start(sessionId: string, event: { toolCallId: string; toolName: string; args: unknown }): void;
  end(
    sessionId: string,
    event: {
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
    },
  ): void;
  /** Resolves when every queued write has finished. */
  close(): Promise<void>;
}

export function createToolLog(options: {
  filePath: string;
  redactor: Redactor;
  now?: () => Date;
  logError?: (message: string) => void;
}): ToolLog {
  const { filePath, redactor } = options;
  const now = options.now ?? (() => new Date());
  const logError = options.logError ?? ((message: string) => console.error(message));

  /** Args prepared at start, keyed by `${sessionId}:${toolCallId}`, in insertion order. */
  const pending = new Map<string, unknown>();

  let directoryReady = false;
  // Every write is chained here, so lines are written in call order and never interleave.
  // Each link swallows its own error, so the chain never rejects.
  let queue: Promise<void> = Promise.resolve();

  const writeLine = async (line: string): Promise<void> => {
    try {
      if (!directoryReady) {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      await appendFile(filePath, line, { mode: 0o600 });
    } catch (error) {
      logError(`tool log: cannot write: ${errorMessage(error)}`);
    }
  };

  const start: ToolLog["start"] = (sessionId, event) => {
    try {
      const key = pendingKey(sessionId, event.toolCallId);
      pending.delete(key);
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) {
          pending.delete(oldest);
        }
      }
      pending.set(key, prepareArgs(event.args, redactor));
    } catch (error) {
      logError(`tool log: cannot record start: ${errorMessage(error)}`);
    }
  };

  const end: ToolLog["end"] = (sessionId, event) => {
    try {
      const key = pendingKey(sessionId, event.toolCallId);
      const args = pending.get(key) ?? null;
      pending.delete(key);

      const entry: ToolLogEntry = {
        ts: now().toISOString(),
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args,
        isError: event.isError,
        result: prepareResult(event.result, redactor),
      };
      if (typeof event.durationMs === "number") {
        entry.durationMs = event.durationMs;
      }

      const line = `${JSON.stringify(redactor.redact(entry))}\n`;
      queue = queue.then(() => writeLine(line));
    } catch (error) {
      logError(`tool log: cannot serialize entry: ${errorMessage(error)}`);
    }
  };

  return {
    start,
    end,
    close() {
      return queue;
    },
  };
}

function pendingKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

/**
 * Redacts the args before truncating, so a secret cut by the limit cannot leak its prefix.
 * Returns the redacted value, or a truncation marker when its JSON is too long or cannot be serialized.
 */
function prepareArgs(args: unknown, redactor: Redactor): unknown {
  let redacted: unknown;
  let json: string | undefined;
  try {
    redacted = redactor.redact(args);
    json = JSON.stringify(redacted);
  } catch {
    return { truncated: true, preview: "" };
  }
  if (json === undefined) {
    return null;
  }
  const safeJson = redactor.redactString(json);
  if (safeJson.length > MAX_ARGS_CHARS) {
    return { truncated: true, preview: safeJson.slice(0, MAX_ARGS_CHARS) };
  }
  return redacted;
}

/** Joins the text parts of an MCP-style result (`{ content: [...] }`), redacted and cut. */
function prepareResult(result: unknown, redactor: Redactor): string {
  if (typeof result !== "object" || result === null) {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const { type, text } = part as { type?: unknown; text?: unknown };
      if (type === "text" && typeof text === "string") {
        texts.push(text);
      }
    }
  }
  return redactor.redactString(texts.join("\n")).slice(0, MAX_RESULT_CHARS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
