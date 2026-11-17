import type {
  Checkpoint,
  NetworkLogEntry,
  PiMessage,
  Question,
  SessionEvent,
  SessionInfo,
  StreamEvent,
  TodoItem,
} from "@cna/shared";
import { describe, expect, it } from "vitest";
import {
  initialViewState,
  NETWORK_VIEW_LIMIT,
  reduceView,
  type TranscriptItem,
  type ViewState,
} from "../src/state.js";

function ev(id: number, event: SessionEvent): StreamEvent {
  return { id, ts: "2026-11-17T10:00:00.000Z", event };
}

function run(state: ViewState, events: StreamEvent[]): ViewState {
  return events.reduce((current, event) => reduceView(current, { type: "event", event }), state);
}

function apply(state: ViewState, event: SessionEvent, id = state.lastEventId + 1): ViewState {
  return reduceView(state, { type: "event", event: ev(id, event) });
}

const session: SessionInfo = {
  id: "s1",
  status: "running",
  repo: "octo/repo",
  baseBranch: "main",
  branch: "agent/x",
  model: null,
  thinking: null,
  mode: "auto",
  autoPush: false,
  createdAt: "2026-11-17T10:00:00.000Z",
  pr: null,
  suspended: false,
  pendingQuestions: [],
};

function question(id: string): Question {
  return {
    id,
    kind: "ask_user",
    method: "input",
    title: `Pregunta ${id}`,
    createdAt: "2026-11-17T10:00:00.000Z",
  };
}

function checkpoint(id: number): Checkpoint {
  return {
    id,
    commit: String(id).padStart(40, "a"),
    createdAt: "2026-11-17T10:00:00.000Z",
    reason: "run",
  };
}

function todo(id: number): TodoItem {
  return { id, text: `Tarea ${id}`, status: "pending" };
}

function netEntry(n: number): NetworkLogEntry {
  return {
    ts: "2026-11-17T10:00:00.000Z",
    method: "CONNECT",
    host: `host${n}.example`,
    port: 443,
    decision: "allow",
    reason: "allowlist",
    bytesOut: n,
    bytesIn: 0,
    durationMs: 1,
  };
}

const assistantMessage = (content: unknown[], extra: Record<string, unknown> = {}): PiMessage => ({
  role: "assistant",
  content,
  ...extra,
});

function transcriptOf(state: ViewState): TranscriptItem[] {
  return state.transcript;
}

describe("initialViewState", () => {
  it("starts empty", () => {
    expect(initialViewState).toEqual({
      session: null,
      transcript: [],
      questions: [],
      todos: [],
      checkpoints: [],
      network: [],
      truncated: false,
      lastEventId: 0,
      nextKey: 1,
    });
  });
});

describe("streaming assistant messages", () => {
  it("creates a streaming assistant on the first delta and extends it", () => {
    let state = apply(initialViewState, { type: "message_delta", contentIndex: 0, delta: "Hola" });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "Hola", thinking: "", streaming: true },
    ]);
    expect(state.nextKey).toBe(2);
    state = apply(state, { type: "message_delta", contentIndex: 0, delta: ", mundo" });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "Hola, mundo", thinking: "", streaming: true },
    ]);
    expect(state.nextKey).toBe(2);
    expect(state.lastEventId).toBe(2);
  });

  it("accumulates thinking_delta on the streaming assistant", () => {
    let state = apply(initialViewState, {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Pienso",
    });
    state = apply(state, { type: "thinking_delta", contentIndex: 0, delta: "..." });
    state = apply(state, { type: "message_delta", contentIndex: 1, delta: "Respuesta" });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "Respuesta", thinking: "Pienso...", streaming: true },
    ]);
  });

  it("replaces the streaming assistant with the final message keeping its key", () => {
    let state = run(initialViewState, [
      ev(1, { type: "message_delta", contentIndex: 0, delta: "Hol" }),
    ]);
    state = apply(state, {
      type: "message",
      message: assistantMessage([
        { type: "thinking", thinking: "Razono" },
        { type: "text", text: "Hola" },
      ]),
    });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "Hola", thinking: "Razono", streaming: false },
    ]);
    expect(state.nextKey).toBe(2);
  });

  it("removes the streaming assistant when the final message only calls tools", () => {
    let state = apply(initialViewState, {
      type: "message_delta",
      contentIndex: 0,
      delta: "Voy a mirar",
    });
    state = apply(state, {
      type: "message",
      message: assistantMessage([
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      ]),
    });
    expect(transcriptOf(state)).toEqual([]);
    expect(state.lastEventId).toBe(2);
  });

  it("does not add anything for a tool-only final message without a streaming item", () => {
    const state = apply(initialViewState, {
      type: "message",
      message: assistantMessage([{ type: "toolCall", id: "t1", name: "read", arguments: {} }]),
    });
    expect(state.transcript).toBe(initialViewState.transcript);
    expect(state.nextKey).toBe(1);
  });

  it("keeps errorMessage on the assistant item", () => {
    let state = apply(initialViewState, {
      type: "message_delta",
      contentIndex: 0,
      delta: "Parcial",
    });
    state = apply(state, {
      type: "message",
      message: assistantMessage([{ type: "text", text: "Parcial" }], {
        stopReason: "error",
        errorMessage: "rate limited",
      }),
    });
    expect(transcriptOf(state)).toEqual([
      {
        kind: "assistant",
        key: "1",
        text: "Parcial",
        thinking: "",
        streaming: false,
        error: "rate limited",
      },
    ]);
  });

  it("keeps an assistant that only has an error (no text)", () => {
    const state = apply(initialViewState, {
      type: "message",
      message: assistantMessage([], { errorMessage: "boom" }),
    });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "", thinking: "", streaming: false, error: "boom" },
    ]);
  });

  it("ignores an empty errorMessage", () => {
    const state = apply(initialViewState, {
      type: "message",
      message: assistantMessage([{ type: "text", text: "ok" }], { errorMessage: "" }),
    });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "ok", thinking: "", streaming: false },
    ]);
  });

  it("adds a final assistant message that had no streaming item", () => {
    const state = apply(initialViewState, {
      type: "message",
      message: assistantMessage([{ type: "text", text: "Directo" }]),
    });
    expect(transcriptOf(state)).toEqual([
      { kind: "assistant", key: "1", text: "Directo", thinking: "", streaming: false },
    ]);
    expect(state.nextKey).toBe(2);
  });

  it("adds a user message", () => {
    const state = apply(initialViewState, {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Hazlo" }], timestamp: 1 },
    });
    expect(transcriptOf(state)).toEqual([{ kind: "user", key: "1", text: "Hazlo" }]);
  });

  it("ignores toolResult messages in the transcript", () => {
    const state = apply(initialViewState, {
      type: "message",
      message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "x" }] },
    });
    expect(state.transcript).toBe(initialViewState.transcript);
    expect(state.nextKey).toBe(1);
  });
});

describe("tool events", () => {
  it("tool_start adds a running item", () => {
    const state = apply(initialViewState, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(transcriptOf(state)).toEqual([
      {
        kind: "tool",
        key: "1",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
        status: "running",
        output: "",
      },
    ]);
  });

  it("tool_start with a repeated toolCallId updates the item instead of duplicating it", () => {
    let state = apply(initialViewState, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    state = apply(state, {
      type: "tool_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: "parcial",
    });
    state = apply(state, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "pwd" },
    });
    expect(transcriptOf(state)).toEqual([
      {
        kind: "tool",
        key: "1",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "pwd" },
        status: "running",
        output: "",
      },
    ]);
    expect(state.nextKey).toBe(2);
  });

  it("tool_update replaces the output with the partial result text", () => {
    let state = apply(initialViewState, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    state = apply(state, {
      type: "tool_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: {
        content: [
          { type: "text", text: "uno" },
          { type: "text", text: "dos" },
        ],
      },
    });
    expect(transcriptOf(state)[0]).toMatchObject({ status: "running", output: "uno\ndos" });
  });

  it("tool_update without a matching item is ignored", () => {
    const state = apply(initialViewState, {
      type: "tool_update",
      toolCallId: "nope",
      toolName: "bash",
      partialResult: "x",
    });
    expect(state.transcript).toBe(initialViewState.transcript);
    expect(state.lastEventId).toBe(1);
  });

  it("tool_end sets status done, output and durationMs", () => {
    let state = apply(initialViewState, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    state = apply(state, {
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "a.txt" }] },
      isError: false,
      durationMs: 42,
    });
    expect(transcriptOf(state)).toEqual([
      {
        kind: "tool",
        key: "1",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
        status: "done",
        output: "a.txt",
        durationMs: 42,
      },
    ]);
  });

  it("tool_end with isError sets status error", () => {
    let state = apply(initialViewState, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    state = apply(state, {
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "fallo",
      isError: true,
    });
    expect(transcriptOf(state)[0]).toMatchObject({ status: "error", output: "fallo" });
    expect(transcriptOf(state)[0]).not.toHaveProperty("durationMs");
  });

  it("tool_end without a start adds a finished item with args undefined", () => {
    const state = apply(initialViewState, {
      type: "tool_end",
      toolCallId: "t9",
      toolName: "read",
      result: "contenido",
      isError: false,
      durationMs: 3,
    });
    expect(transcriptOf(state)).toEqual([
      {
        kind: "tool",
        key: "1",
        toolCallId: "t9",
        toolName: "read",
        args: undefined,
        status: "done",
        output: "contenido",
        durationMs: 3,
      },
    ]);
    expect(state.nextKey).toBe(2);
  });

  it("tool_end keeps the previous durationMs when the event has none", () => {
    let state = apply(initialViewState, {
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "",
      isError: false,
      durationMs: 7,
    });
    state = apply(state, {
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "otra",
      isError: false,
    });
    expect(transcriptOf(state)[0]).toMatchObject({ durationMs: 7, output: "otra" });
  });

  it("an unchanged transcript item keeps its reference", () => {
    let state = run(initialViewState, [
      ev(1, { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} }),
      ev(2, { type: "tool_start", toolCallId: "t2", toolName: "bash", args: {} }),
    ]);
    const first = state.transcript[0];
    state = apply(state, {
      type: "tool_update",
      toolCallId: "t2",
      toolName: "bash",
      partialResult: "x",
    });
    expect(state.transcript[0]).toBe(first);
    expect(state.transcript[1]).toMatchObject({ output: "x" });
  });
});

describe("questions", () => {
  it("adds a question", () => {
    const state = apply(initialViewState, { type: "question", question: question("q1") });
    expect(state.questions).toEqual([question("q1")]);
  });

  it("ignores a duplicated question keeping the same reference", () => {
    const state = apply(initialViewState, { type: "question", question: question("q1") });
    const next = apply(state, { type: "question", question: question("q1") });
    expect(next.questions).toBe(state.questions);
    expect(next.lastEventId).toBe(2);
  });

  it("removes a resolved question", () => {
    let state = run(initialViewState, [
      ev(1, { type: "question", question: question("q1") }),
      ev(2, { type: "question", question: question("q2") }),
    ]);
    state = apply(state, { type: "question_resolved", questionId: "q1", outcome: "answered" });
    expect(state.questions).toEqual([question("q2")]);
  });

  it("resolving an unknown question keeps the questions reference", () => {
    const state = apply(initialViewState, { type: "question", question: question("q1") });
    const next = apply(state, { type: "question_resolved", questionId: "zz", outcome: "timeout" });
    expect(next.questions).toBe(state.questions);
  });
});

describe("status and session", () => {
  const withSession: ViewState = { ...initialViewState, session, lastEventId: 4, nextKey: 5 };

  it("updates the status of the session", () => {
    const state = apply(withSession, { type: "status", status: "ready" });
    expect(state.session).toEqual({ ...session, status: "ready" });
    expect(state.transcript).toBe(withSession.transcript);
  });

  it("sets and removes the error of the session", () => {
    let state = apply(withSession, { type: "status", status: "error", error: "git falló" });
    expect(state.session).toEqual({ ...session, status: "error", error: "git falló" });
    state = apply(state, { type: "status", status: "running" });
    expect(state.session).toEqual({ ...session, status: "running" });
    expect(state.session).not.toHaveProperty("error");
  });

  it("does not create a session from a status event", () => {
    const state = apply(initialViewState, { type: "status", status: "running" });
    expect(state.session).toBeNull();
    expect(state.transcript).toBe(initialViewState.transcript);
  });

  it("adds an error notice on status error", () => {
    let state = apply(withSession, { type: "status", status: "error", error: "sin red" });
    expect(transcriptOf(state)).toEqual([
      { kind: "notice", key: "5", level: "error", text: "La sesión falló: sin red" },
    ]);
    state = apply(state, { type: "status", status: "error" });
    expect(transcriptOf(state)[1]).toEqual({
      kind: "notice",
      key: "6",
      level: "error",
      text: "La sesión falló",
    });
  });

  it("applies mode to the session", () => {
    const state = apply(withSession, { type: "mode", mode: "plan" });
    expect(state.session).toEqual({ ...session, mode: "plan" });
  });

  it("mode without a session does nothing", () => {
    const state = apply(initialViewState, { type: "mode", mode: "plan" });
    expect(state.session).toBeNull();
  });

  it("mode with the same value keeps the session reference", () => {
    const state = apply(withSession, { type: "mode", mode: "auto" });
    expect(state.session).toBe(withSession.session);
  });

  it("session action sets session and questions from pendingQuestions", () => {
    const pending = [question("q1")];
    const state = reduceView(initialViewState, {
      type: "session",
      session: { ...session, pendingQuestions: pending },
    });
    expect(state.session?.pendingQuestions).toEqual(pending);
    expect(state.questions).toEqual(pending);
  });

  it("session action with null clears session and questions", () => {
    const withQuestion = apply(initialViewState, { type: "question", question: question("q1") });
    const state = reduceView(withQuestion, { type: "session", session: null });
    expect(state.session).toBeNull();
    expect(state.questions).toEqual([]);
  });

  it("session action with the same pending questions keeps the questions reference", () => {
    const state = reduceView(initialViewState, {
      type: "session",
      session: { ...session, pendingQuestions: [question("q1")] },
    });
    const next = reduceView(state, {
      type: "session",
      session: { ...session, pendingQuestions: [question("q1")] },
    });
    expect(next.questions).toBe(state.questions);
  });
});

describe("todos, checkpoints and network", () => {
  it("todo replaces the list", () => {
    const state = apply(initialViewState, { type: "todo", todos: [todo(1), todo(2)] });
    expect(state.todos).toEqual([todo(1), todo(2)]);
  });

  it("checkpoint created is added in id order without duplicates", () => {
    let state = run(initialViewState, [
      ev(1, { type: "checkpoint", action: "created", checkpoint: checkpoint(2) }),
      ev(2, { type: "checkpoint", action: "created", checkpoint: checkpoint(0) }),
      ev(3, { type: "checkpoint", action: "created", checkpoint: checkpoint(1) }),
    ]);
    expect(state.checkpoints.map((c) => c.id)).toEqual([0, 1, 2]);
    const before = state.checkpoints;
    state = apply(state, { type: "checkpoint", action: "created", checkpoint: checkpoint(1) });
    expect(state.checkpoints).toBe(before);
  });

  it("checkpoint restored adds an info notice and keeps the list", () => {
    const withList = apply(initialViewState, {
      type: "checkpoint",
      action: "created",
      checkpoint: checkpoint(0),
    });
    const state = apply(withList, {
      type: "checkpoint",
      action: "restored",
      checkpoint: checkpoint(0),
    });
    expect(state.checkpoints).toBe(withList.checkpoints);
    expect(transcriptOf(state)).toEqual([
      { kind: "notice", key: "1", level: "info", text: "Restaurado el checkpoint #0" },
    ]);
  });

  it("network entries are appended and trimmed to NETWORK_VIEW_LIMIT", () => {
    let state = initialViewState;
    for (let n = 1; n <= NETWORK_VIEW_LIMIT + 1; n++) {
      state = apply(state, { type: "network", entry: netEntry(n) });
    }
    expect(state.network).toHaveLength(NETWORK_VIEW_LIMIT);
    expect(state.network[0]?.bytesOut).toBe(2);
    expect(state.network.at(-1)?.bytesOut).toBe(NETWORK_VIEW_LIMIT + 1);
  });

  it("networkLog keeps the last NETWORK_VIEW_LIMIT entries", () => {
    const entries = Array.from({ length: NETWORK_VIEW_LIMIT + 5 }, (_, i) => netEntry(i + 1));
    const state = reduceView(initialViewState, { type: "networkLog", entries });
    expect(state.network).toHaveLength(NETWORK_VIEW_LIMIT);
    expect(state.network[0]?.bytesOut).toBe(6);
  });
});

describe("compaction, retry and notify", () => {
  it("compaction start, end, error, aborted", () => {
    const state = run(initialViewState, [
      ev(1, { type: "compaction", phase: "start", reason: "manual" }),
      ev(2, { type: "compaction", phase: "end", reason: "manual" }),
      ev(3, { type: "compaction", phase: "end", reason: "threshold", error: "sin modelo" }),
      ev(4, { type: "compaction", phase: "end", reason: "overflow", aborted: true }),
    ]);
    expect(transcriptOf(state)).toEqual([
      { kind: "notice", key: "1", level: "info", text: "Compactando el contexto…" },
      { kind: "notice", key: "2", level: "info", text: "Contexto compactado" },
      { kind: "notice", key: "3", level: "warning", text: "La compactación falló: sin modelo" },
      { kind: "notice", key: "4", level: "warning", text: "Compactación cancelada" },
    ]);
  });

  it("retry start with and without maxAttempts", () => {
    const state = run(initialViewState, [
      ev(1, { type: "retry", phase: "start", attempt: 1, maxAttempts: 3, delayMs: 100 }),
      ev(2, { type: "retry", phase: "start", attempt: 2 }),
    ]);
    expect(transcriptOf(state)).toEqual([
      { kind: "notice", key: "1", level: "warning", text: "Reintentando (1/3)…" },
      { kind: "notice", key: "2", level: "warning", text: "Reintentando (2/?)…" },
    ]);
  });

  it("retry end with failure, with and without detail", () => {
    const state = run(initialViewState, [
      ev(1, { type: "retry", phase: "end", attempt: 1, success: false, error: "timeout" }),
      ev(2, { type: "retry", phase: "end", attempt: 2, success: false }),
    ]);
    expect(transcriptOf(state)).toEqual([
      { kind: "notice", key: "1", level: "error", text: "El reintento falló: timeout" },
      { kind: "notice", key: "2", level: "error", text: "El reintento falló: sin detalle" },
    ]);
  });

  it("retry end with success adds no notice", () => {
    const state = apply(initialViewState, {
      type: "retry",
      phase: "end",
      attempt: 1,
      success: true,
    });
    expect(state.transcript).toBe(initialViewState.transcript);
    expect(state.lastEventId).toBe(1);
  });

  it("notify and error add notices with their level", () => {
    const state = run(initialViewState, [
      ev(1, { type: "notify", level: "warning", message: "Cuidado" }),
      ev(2, { type: "error", message: "Algo va mal" }),
    ]);
    expect(transcriptOf(state)).toEqual([
      { kind: "notice", key: "1", level: "warning", text: "Cuidado" },
      { kind: "notice", key: "2", level: "error", text: "Algo va mal" },
    ]);
  });
});

describe("reset, truncated and messages", () => {
  it("reset goes back to the initial state", () => {
    const busy = run(initialViewState, [
      ev(1, { type: "message_delta", contentIndex: 0, delta: "x" }),
      ev(2, { type: "todo", todos: [todo(1)] }),
    ]);
    expect(reduceView(busy, { type: "reset" })).toEqual(initialViewState);
  });

  it("truncated sets the flag", () => {
    const state = reduceView(initialViewState, { type: "truncated" });
    expect(state.truncated).toBe(true);
  });

  it("messages rebuilds user, assistant and tool items with their results", () => {
    const messages: PiMessage[] = [
      { role: "user", content: [{ type: "text", text: "Lista los ficheros" }], timestamp: 1 },
      assistantMessage([
        { type: "thinking", thinking: "Voy a listar" },
        { type: "text", text: "Listo" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "t2", name: "read", arguments: { path: "a" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "a.txt" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "t2",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
      assistantMessage([{ type: "toolCall", id: "t3", name: "todo", arguments: {} }]),
      { role: "toolResult", toolCallId: "t3", content: [], isError: false },
      { role: "custom", content: "ignorado" },
    ];
    const start: ViewState = {
      ...initialViewState,
      truncated: true,
      nextKey: 10,
      transcript: [{ kind: "notice", key: "9", level: "info", text: "vieja" }],
    };
    const state = reduceView(start, { type: "messages", messages });
    expect(state.truncated).toBe(false);
    expect(state.nextKey).toBe(15);
    expect(transcriptOf(state)).toEqual([
      { kind: "user", key: "10", text: "Lista los ficheros" },
      {
        kind: "assistant",
        key: "11",
        text: "Listo",
        thinking: "Voy a listar",
        streaming: false,
      },
      {
        kind: "tool",
        key: "12",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
        status: "done",
        output: "a.txt",
      },
      {
        kind: "tool",
        key: "13",
        toolCallId: "t2",
        toolName: "read",
        args: { path: "a" },
        status: "error",
        output: "boom",
      },
      {
        kind: "tool",
        key: "14",
        toolCallId: "t3",
        toolName: "todo",
        args: {},
        status: "done",
        output: "",
      },
    ]);
  });

  it("messages keeps an error on the assistant item", () => {
    const state = reduceView(initialViewState, {
      type: "messages",
      messages: [assistantMessage([], { errorMessage: "cuota agotada" })],
    });
    expect(transcriptOf(state)).toEqual([
      {
        kind: "assistant",
        key: "1",
        text: "",
        thinking: "",
        streaming: false,
        error: "cuota agotada",
      },
    ]);
  });

  it("todos and checkpoints actions replace their lists", () => {
    let state = reduceView(initialViewState, { type: "todos", todos: [todo(1)] });
    state = reduceView(state, { type: "checkpoints", checkpoints: [checkpoint(0)] });
    expect(state.todos).toEqual([todo(1)]);
    expect(state.checkpoints).toEqual([checkpoint(0)]);
  });
});

describe("slice identity and immutability", () => {
  const busy: ViewState = run(
    { ...initialViewState, session, questions: [question("q1")], todos: [todo(1)] },
    [ev(1, { type: "message_delta", contentIndex: 0, delta: "base" })],
  );

  it("a delta changes transcript and lastEventId but keeps the other slices", () => {
    const next = apply(busy, { type: "message_delta", contentIndex: 0, delta: "!" });
    expect(next.transcript).not.toBe(busy.transcript);
    expect(next.lastEventId).toBe(busy.lastEventId + 1);
    expect(next.questions).toBe(busy.questions);
    expect(next.todos).toBe(busy.todos);
    expect(next.checkpoints).toBe(busy.checkpoints);
    expect(next.network).toBe(busy.network);
    expect(next.session).toBe(busy.session);
  });

  it("an unchanged assistant item keeps its reference", () => {
    const withTool = apply(busy, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    const next = apply(withTool, {
      type: "tool_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: "",
    });
    expect(next.transcript[0]).toBe(withTool.transcript[0]);
    expect(next.transcript).toBe(withTool.transcript);
  });

  it("a network event keeps transcript, questions and session", () => {
    const next = apply(busy, { type: "network", entry: netEntry(1) });
    expect(next.transcript).toBe(busy.transcript);
    expect(next.questions).toBe(busy.questions);
    expect(next.session).toBe(busy.session);
    expect(next.network).toHaveLength(1);
  });

  it("a todo event keeps the session and questions", () => {
    const next = apply(busy, { type: "todo", todos: [todo(2)] });
    expect(next.session).toBe(busy.session);
    expect(next.questions).toBe(busy.questions);
  });

  it("does not mutate the original state", () => {
    const snapshot = structuredClone(busy);
    apply(busy, { type: "message_delta", contentIndex: 0, delta: "más" });
    apply(busy, { type: "status", status: "error", error: "x" });
    apply(busy, { type: "question_resolved", questionId: "q1", outcome: "answered" });
    apply(busy, { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} });
    apply(busy, { type: "message", message: assistantMessage([{ type: "text", text: "fin" }]) });
    reduceView(busy, { type: "messages", messages: [{ role: "user", content: "hola" }] });
    reduceView(busy, { type: "networkLog", entries: [netEntry(1)] });
    expect(busy).toEqual(snapshot);
  });
});

describe("history event", () => {
  it("rebuilds the transcript from the resumed conversation", () => {
    const withNotice = reduceView(initialViewState, {
      type: "event",
      event: { id: 1, ts: "2026-11-17T00:00:00.000Z", event: { type: "error", message: "old" } },
    });
    const next = reduceView(withNotice, {
      type: "event",
      event: {
        id: 2,
        ts: "2026-11-17T00:00:00.000Z",
        event: {
          type: "history",
          messages: [
            { role: "user", content: "hola" },
            { role: "assistant", content: [{ type: "text", text: "adiós" }] },
          ],
        },
      },
    });
    expect(next.transcript.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(next.lastEventId).toBe(2);
  });
});
