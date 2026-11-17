import type { SessionEvent, TodoStatus } from "@cna/shared";
import { messageText, toolResultText } from "@cna/shared/client";
import { type StyleName, sanitize, style } from "./style.js";

export interface EventPrinterOptions {
  color: boolean;
  /** Print thinking deltas (dim). Default false. */
  showThinking?: boolean;
}

const ARGS_MAX_LENGTH = 120;
const ERROR_MAX_LENGTH = 200;
const ELLIPSIS = "…";

const TODO_MARKS: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
};

/** Keeps at most `max` code points (never splits an emoji); a cut text ends with "…". */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return chars.slice(0, max - 1).join("") + ELLIPSIS;
}

/** Arguments of a tool call as JSON, sanitized and truncated. "" if they cannot be serialized. */
function summarizeArgs(args: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return "";
  }
  if (json === undefined) {
    return "";
  }
  return truncate(sanitize(json), ARGS_MAX_LENGTH);
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/**
 * Turns the SSE events of a session into the text printed on the terminal. It keeps track of
 * whether a streamed line is open, so that the next line starts on a new line.
 */
export class EventPrinter {
  private readonly color: boolean;
  private readonly showThinking: boolean;
  /** A streamed line (text or thinking) has no "\n" yet. */
  private lineOpen = false;
  private openKind: "text" | "thinking" | null = null;
  /** Text of the assistant message in progress was streamed (its final text is not printed again). */
  private streamedText = false;

  constructor(options: EventPrinterOptions) {
    this.color = options.color;
    this.showThinking = options.showThinking ?? false;
  }

  /** Text to write to stdout for this event ("" if nothing). Tracks whether a streamed line is open. */
  format(event: SessionEvent): string {
    switch (event.type) {
      case "message_delta":
        return this.streamDelta(event.delta, "text");
      case "thinking_delta":
        return this.showThinking ? this.streamDelta(event.delta, "thinking") : "";
      case "message":
        return this.formatMessage(event.message);
      case "tool_start":
        return this.line(
          this.paint(`⚙ ${sanitize(event.toolName)} ${summarizeArgs(event.args)}`, "cyan"),
        );
      case "tool_update":
        return "";
      case "tool_end":
        return this.formatToolEnd(event);
      case "question":
      case "question_resolved":
        return "";
      case "status":
        return this.formatStatus(event);
      case "todo":
        return this.formatTodos(event.todos);
      case "checkpoint": {
        const id = event.checkpoint.id;
        const label =
          event.action === "created"
            ? `checkpoint #${id} creado`
            : `restaurado el checkpoint #${id}`;
        return this.line(this.paint(label, "dim"));
      }
      case "mode":
        return this.line(this.paint(`modo: ${sanitize(event.mode)}`, "yellow"));
      case "network": {
        const { host, port, reason } = event.entry;
        if (event.entry.decision !== "deny") {
          return "";
        }
        return this.line(
          this.paint(`red: denegado ${sanitize(host)}:${port} (${sanitize(reason)})`, "yellow"),
        );
      }
      case "compaction":
        return this.formatCompaction(event);
      case "retry":
        return this.formatRetry(event);
      case "notify":
        return this.formatNotify(event);
      case "error":
        return this.line(this.paint(`error: ${sanitize(event.message)}`, "red"));
    }
  }

  private paint(text: string, ...styles: StyleName[]): string {
    return style(text, this.color, ...styles);
  }

  /** Closes the open streamed line, if any. */
  private closeLine(): string {
    if (!this.lineOpen) {
      return "";
    }
    this.lineOpen = false;
    this.openKind = null;
    return "\n";
  }

  /** Closes the open streamed line and writes `text` as a complete line. */
  private line(text: string): string {
    return `${this.closeLine()}${text}\n`;
  }

  private streamDelta(delta: string, kind: "text" | "thinking"): string {
    if (delta === "") {
      return "";
    }
    // A text delta after thinking (or the other way round) must not share a line with it.
    const prefix = this.lineOpen && this.openKind !== kind ? "\n" : "";
    const text = sanitize(delta);
    this.lineOpen = !text.endsWith("\n");
    this.openKind = this.lineOpen ? kind : null;
    if (kind === "text") {
      this.streamedText = true;
      return `${prefix}${text}`;
    }
    return `${prefix}${this.paint(text, "dim")}`;
  }

  private formatMessage(message: { role: string } & Record<string, unknown>): string {
    if (message.role === "user") {
      return this.line(this.paint(`> ${sanitize(messageText(message))}`, "bold"));
    }
    if (message.role !== "assistant") {
      return "";
    }
    let out = this.closeLine();
    if (!this.streamedText) {
      const text = messageText(message);
      if (text !== "") {
        out += `${sanitize(text)}\n`;
      }
    }
    this.streamedText = false;
    const error = message.errorMessage;
    if (typeof error === "string" && error !== "") {
      out += `${this.paint(`error: ${sanitize(error)}`, "red")}\n`;
    }
    return out;
  }

  private formatToolEnd(event: Extract<SessionEvent, { type: "tool_end" }>): string {
    const name = sanitize(event.toolName);
    if (event.isError) {
      const detail = truncate(sanitize(firstLine(toolResultText(event.result))), ERROR_MAX_LENGTH);
      return this.line(this.paint(`✗ ${name}: ${detail}`, "red"));
    }
    const duration = typeof event.durationMs === "number" ? ` (${event.durationMs} ms)` : "";
    return this.line(this.paint(`✓ ${name}${duration}`, "dim"));
  }

  private formatStatus(event: Extract<SessionEvent, { type: "status" }>): string {
    const label = `[estado] ${sanitize(event.status)}`;
    if (event.status === "error") {
      const detail = event.error ? `: ${sanitize(event.error)}` : "";
      return this.line(this.paint(label + detail, "red"));
    }
    return this.line(this.paint(label, "dim"));
  }

  private formatTodos(todos: Extract<SessionEvent, { type: "todo" }>["todos"]): string {
    if (todos.length === 0) {
      return this.line("Tareas: (vacía)");
    }
    const rows = todos.map((todo) => `  [${TODO_MARKS[todo.status]}] ${sanitize(todo.text)}`);
    return this.line(["Tareas:", ...rows].join("\n"));
  }

  private formatCompaction(event: Extract<SessionEvent, { type: "compaction" }>): string {
    if (event.phase === "start") {
      return this.line(this.paint("compactando el contexto…", "dim"));
    }
    if (event.aborted) {
      return this.line(this.paint("compactación cancelada", "yellow"));
    }
    if (event.error) {
      return this.line(this.paint(`la compactación falló: ${sanitize(event.error)}`, "yellow"));
    }
    return this.line(this.paint("contexto compactado", "dim"));
  }

  private formatRetry(event: Extract<SessionEvent, { type: "retry" }>): string {
    if (event.phase === "start") {
      const max = event.maxAttempts ?? "?";
      return this.line(this.paint(`reintentando (${event.attempt}/${max})…`, "yellow"));
    }
    if (event.success === false) {
      const detail = event.error ? sanitize(event.error) : "sin detalle";
      return this.line(this.paint(`el reintento falló: ${detail}`, "red"));
    }
    return "";
  }

  private formatNotify(event: Extract<SessionEvent, { type: "notify" }>): string {
    const message = sanitize(event.message);
    switch (event.level) {
      case "info":
        return this.line(`[info] ${message}`);
      case "warning":
        return this.line(this.paint(`[aviso] ${message}`, "yellow"));
      case "error":
        return this.line(this.paint(`[error] ${message}`, "red"));
    }
  }
}
