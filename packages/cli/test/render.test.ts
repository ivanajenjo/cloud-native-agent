import type { NetworkLogEntry, PiMessage, SessionEvent } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { EventPrinter } from "../src/render.js";
import { sanitize, style } from "../src/style.js";

const ESC = "\x1b";

function assistant(text: string, extra: Record<string, unknown> = {}): PiMessage {
  return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

/** Feeds events through a printer and joins what it prints. */
function run(events: SessionEvent[], options: { color?: boolean; showThinking?: boolean } = {}) {
  const printer = new EventPrinter({
    color: options.color ?? false,
    showThinking: options.showThinking,
  });
  return events.map((event) => printer.format(event)).join("");
}

function networkEntry(decision: NetworkLogEntry["decision"]): NetworkLogEntry {
  return {
    ts: "2026-11-17T10:00:00.000Z",
    method: "CONNECT",
    host: "example.com",
    port: 443,
    decision,
    reason: decision === "deny" ? "user_denied" : "allowlist",
    bytesOut: 0,
    bytesIn: 0,
    durationMs: 1,
  };
}

describe("style", () => {
  it("returns the text unchanged without color", () => {
    expect(style("x", false, "bold", "red")).toBe("x");
  });

  it("wraps the text with one or several codes when enabled", () => {
    expect(style("x", true, "bold", "red")).toBe("\x1b[1;31mx\x1b[0m");
    expect(style("x", true, "dim")).toBe("\x1b[2mx\x1b[0m");
    expect(style("x", true, "green")).toBe("\x1b[32mx\x1b[0m");
    expect(style("x", true, "yellow")).toBe("\x1b[33mx\x1b[0m");
    expect(style("x", true, "cyan")).toBe("\x1b[36mx\x1b[0m");
  });

  it("returns the text unchanged when enabled without styles", () => {
    expect(style("x", true)).toBe("x");
  });
});

describe("sanitize", () => {
  it("removes clear-screen, bell and C1 CSI sequences", () => {
    expect(sanitize("a\x1b[2Jb")).toBe("a\uFFFD[2Jb");
    expect(sanitize("a\x07b")).toBe("a\uFFFDb");
    expect(sanitize("a\x9bb")).toBe("a\uFFFDb");
  });

  it("keeps newlines and tabs", () => {
    expect(sanitize("uno\n\tdos")).toBe("uno\n\tdos");
    expect(sanitize("uno\r\ndos")).toBe("uno\ndos");
    expect(sanitize("uno\rdos")).toBe("uno\uFFFDdos");
  });

  it("keeps accents and emojis", () => {
    expect(sanitize("canción 🚀 ñ")).toBe("canción 🚀 ñ");
  });
});

describe("EventPrinter: streamed text", () => {
  it("prints the deltas and closes the line once with the final message", () => {
    const out = run([
      { type: "message_delta", contentIndex: 0, delta: "Hola" },
      { type: "message_delta", contentIndex: 0, delta: " mundo" },
      { type: "message", message: assistant("Hola mundo") },
    ]);
    expect(out).toBe("Hola mundo\n");
  });

  it("prints the final text when there were no deltas", () => {
    expect(run([{ type: "message", message: assistant("Respuesta") }])).toBe("Respuesta\n");
  });

  it("prints nothing for an empty final message", () => {
    expect(run([{ type: "message", message: assistant("") }])).toBe("");
  });

  it("starts a new line when a tool starts after a streamed delta", () => {
    const out = run([
      { type: "message_delta", contentIndex: 0, delta: "Voy a leer" },
      { type: "tool_start", toolCallId: "1", toolName: "read", args: { path: "a.md" } },
    ]);
    expect(out).toBe(`Voy a leer\n⚙ read {"path":"a.md"}\n`);
  });

  it("does not add a newline when a delta already ends with one", () => {
    const out = run([
      { type: "message_delta", contentIndex: 0, delta: "línea\n" },
      { type: "status", status: "running" },
    ]);
    expect(out).toBe("línea\n[estado] running\n");
  });

  it("starts a new text message after the previous one was closed", () => {
    const out = run([
      { type: "message_delta", contentIndex: 0, delta: "uno" },
      { type: "message", message: assistant("uno") },
      { type: "message_delta", contentIndex: 0, delta: "dos" },
      { type: "message", message: assistant("dos") },
    ]);
    expect(out).toBe("uno\ndos\n");
  });

  it("prints the error of an assistant message in red", () => {
    const out = run([{ type: "message", message: assistant("", { errorMessage: "rate limit" }) }], {
      color: true,
    });
    expect(out).toBe(`${ESC}[31merror: rate limit${ESC}[0m\n`);
  });

  it("prints the error without color when color is off", () => {
    const out = run([{ type: "message", message: assistant("x", { errorMessage: "boom" }) }]);
    expect(out).toBe("x\nerror: boom\n");
  });

  it("sanitizes model text", () => {
    const out = run([{ type: "message", message: assistant("\x1b[31mrojo\x1b[0m") }]);
    expect(out).not.toContain(ESC);
    expect(out).toBe("\uFFFD[31mrojo\uFFFD[0m\n");
  });

  it("does not print the deltas of a message that is not streamed again", () => {
    const out = run([
      { type: "message_delta", contentIndex: 0, delta: "hola" },
      { type: "message", message: assistant("hola") },
      { type: "message", message: assistant("otro") },
    ]);
    expect(out).toBe("hola\notro\n");
  });
});

describe("EventPrinter: messages of the user and other roles", () => {
  it("prints user messages with a prompt marker in bold", () => {
    const user: PiMessage = { role: "user", content: [{ type: "text", text: "haz X" }] };
    expect(run([{ type: "message", message: user }], { color: true })).toBe(
      `${ESC}[1m> haz X${ESC}[0m\n`,
    );
  });

  it("prints nothing for other roles", () => {
    expect(run([{ type: "message", message: { role: "toolResult", content: [] } }])).toBe("");
  });
});

describe("EventPrinter: tools", () => {
  it("truncates long arguments to 120 characters", () => {
    const out = run([
      { type: "tool_start", toolCallId: "1", toolName: "write", args: { text: "a".repeat(500) } },
    ]);
    const line = out.slice("⚙ write ".length, -1);
    expect(out.startsWith("⚙ write ")).toBe(true);
    expect(Array.from(line)).toHaveLength(120);
    expect(line.endsWith("…")).toBe(true);
  });

  it("does not truncate short arguments", () => {
    expect(run([{ type: "tool_start", toolCallId: "1", toolName: "read", args: { p: 1 } }])).toBe(
      '⚙ read {"p":1}\n',
    );
  });

  it("does not throw on arguments that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      run([{ type: "tool_start", toolCallId: "1", toolName: "bash", args: circular }]),
    ).not.toThrow();
    expect(run([{ type: "tool_start", toolCallId: "1", toolName: "bash", args: circular }])).toBe(
      "⚙ bash \n",
    );
  });

  it("prints a successful tool end with its duration in dim", () => {
    const out = run(
      [
        {
          type: "tool_end",
          toolCallId: "1",
          toolName: "read",
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
          durationMs: 42,
        },
      ],
      { color: true },
    );
    expect(out).toBe(`${ESC}[2m✓ read (42 ms)${ESC}[0m\n`);
  });

  it("prints a successful tool end without duration", () => {
    expect(
      run([{ type: "tool_end", toolCallId: "1", toolName: "read", result: "", isError: false }]),
    ).toBe("✓ read\n");
  });

  it("prints only the first line of a failed tool in red", () => {
    const out = run(
      [
        {
          type: "tool_end",
          toolCallId: "1",
          toolName: "bash",
          result: {
            content: [
              { type: "text", text: "primera línea" },
              { type: "text", text: "segunda línea" },
            ],
          },
          isError: true,
        },
      ],
      { color: true },
    );
    expect(out).toBe(`${ESC}[31m✗ bash: primera línea${ESC}[0m\n`);
  });

  it("truncates the error line to 200 characters", () => {
    const out = run([
      {
        type: "tool_end",
        toolCallId: "1",
        toolName: "bash",
        result: "e".repeat(300),
        isError: true,
      },
    ]);
    const detail = out.slice("✗ bash: ".length, -1);
    expect(Array.from(detail)).toHaveLength(200);
  });

  it("prints nothing for tool updates", () => {
    expect(
      run([{ type: "tool_update", toolCallId: "1", toolName: "bash", partialResult: "x" }]),
    ).toBe("");
  });
});

describe("EventPrinter: todos", () => {
  it("prints the three states of the tasks", () => {
    const out = run([
      {
        type: "todo",
        todos: [
          { id: 1, text: "uno", status: "pending" },
          { id: 2, text: "dos", status: "in_progress" },
          { id: 3, text: "tres", status: "completed" },
        ],
      },
    ]);
    expect(out).toBe("Tareas:\n  [ ] uno\n  [~] dos\n  [x] tres\n");
  });

  it("prints an empty list", () => {
    expect(run([{ type: "todo", todos: [] }])).toBe("Tareas: (vacía)\n");
  });
});

describe("EventPrinter: other events", () => {
  it("prints nothing for network allow decisions", () => {
    expect(run([{ type: "network", entry: networkEntry("allow") }])).toBe("");
  });

  it("prints a line for network deny decisions", () => {
    expect(run([{ type: "network", entry: networkEntry("deny") }], { color: true })).toBe(
      `${ESC}[33mred: denegado example.com:443 (user_denied)${ESC}[0m\n`,
    );
  });

  it("prints the error status in red with its detail", () => {
    expect(run([{ type: "status", status: "error", error: "clone falló" }], { color: true })).toBe(
      `${ESC}[31m[estado] error: clone falló${ESC}[0m\n`,
    );
  });

  it("prints a plain status in dim", () => {
    expect(run([{ type: "status", status: "ready" }], { color: true })).toBe(
      `${ESC}[2m[estado] ready${ESC}[0m\n`,
    );
  });

  it("prints checkpoints", () => {
    const checkpoint = {
      id: 3,
      commit: "abc",
      createdAt: "2026-11-17T10:00:00.000Z",
      reason: "run" as const,
    };
    expect(run([{ type: "checkpoint", action: "created", checkpoint }])).toBe(
      "checkpoint #3 creado\n",
    );
    expect(run([{ type: "checkpoint", action: "restored", checkpoint }])).toBe(
      "restaurado el checkpoint #3\n",
    );
  });

  it("prints the mode in yellow", () => {
    expect(run([{ type: "mode", mode: "auto" }], { color: true })).toBe(
      `${ESC}[33mmodo: auto${ESC}[0m\n`,
    );
  });

  it("prints compaction start and the three ends", () => {
    expect(run([{ type: "compaction", phase: "start", reason: "manual" }])).toBe(
      "compactando el contexto…\n",
    );
    expect(run([{ type: "compaction", phase: "end", reason: "manual" }])).toBe(
      "contexto compactado\n",
    );
    expect(run([{ type: "compaction", phase: "end", reason: "manual", aborted: true }])).toBe(
      "compactación cancelada\n",
    );
    expect(
      run([{ type: "compaction", phase: "end", reason: "overflow", error: "sin memoria" }]),
    ).toBe("la compactación falló: sin memoria\n");
  });

  it("prints retry start and only a failed retry end", () => {
    expect(run([{ type: "retry", phase: "start", attempt: 2, maxAttempts: 3 }])).toBe(
      "reintentando (2/3)…\n",
    );
    expect(run([{ type: "retry", phase: "start", attempt: 1 }])).toBe("reintentando (1/?)…\n");
    expect(run([{ type: "retry", phase: "end", attempt: 1, success: true }])).toBe("");
    expect(run([{ type: "retry", phase: "end", attempt: 3, success: false }])).toBe(
      "el reintento falló: sin detalle\n",
    );
    expect(run([{ type: "retry", phase: "end", attempt: 3, success: false, error: "503" }])).toBe(
      "el reintento falló: 503\n",
    );
  });

  it("prints notifications by level", () => {
    expect(run([{ type: "notify", level: "info", message: "a" }])).toBe("[info] a\n");
    expect(run([{ type: "notify", level: "warning", message: "b" }], { color: true })).toBe(
      `${ESC}[33m[aviso] b${ESC}[0m\n`,
    );
    expect(run([{ type: "notify", level: "error", message: "c" }], { color: true })).toBe(
      `${ESC}[31m[error] c${ESC}[0m\n`,
    );
  });

  it("prints errors in red", () => {
    expect(run([{ type: "error", message: "fallo" }], { color: true })).toBe(
      `${ESC}[31merror: fallo${ESC}[0m\n`,
    );
  });

  it("prints nothing for questions", () => {
    expect(
      run([
        {
          type: "question_resolved",
          questionId: "q1",
          outcome: "answered",
        },
      ]),
    ).toBe("");
  });
});

describe("EventPrinter: thinking", () => {
  const thinking: SessionEvent = { type: "thinking_delta", contentIndex: 0, delta: "pienso" };

  it("prints nothing without showThinking", () => {
    expect(run([thinking, { type: "message", message: assistant("hola") }])).toBe("hola\n");
  });

  it("prints thinking in dim with showThinking and closes its line before the text", () => {
    const out = run(
      [
        thinking,
        { type: "message_delta", contentIndex: 1, delta: "hola" },
        { type: "message", message: assistant("hola") },
      ],
      { color: true, showThinking: true },
    );
    expect(out).toBe(`${ESC}[2mpienso${ESC}[0m\nhola\n`);
  });
});

describe("EventPrinter: color off", () => {
  it("never emits an escape sequence", () => {
    const out = run([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hola" }] } },
      { type: "tool_start", toolCallId: "1", toolName: "read", args: { a: 1 } },
      { type: "tool_end", toolCallId: "1", toolName: "read", result: "", isError: true },
      {
        type: "tool_end",
        toolCallId: "1",
        toolName: "read",
        result: "",
        isError: false,
        durationMs: 1,
      },
      { type: "status", status: "error", error: "x" },
      { type: "mode", mode: "plan" },
      { type: "error", message: "y" },
      { type: "notify", level: "error", message: "z" },
      { type: "network", entry: networkEntry("deny") },
      { type: "retry", phase: "end", attempt: 1, success: false },
      { type: "compaction", phase: "end", reason: "manual", aborted: true },
    ]);
    expect(out).not.toContain(ESC);
    expect(out.length).toBeGreaterThan(0);
  });
});
