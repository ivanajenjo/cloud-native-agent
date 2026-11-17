import type {
  Checkpoint,
  NetworkLogEntry,
  PiMessage,
  Question,
  SessionInfo,
  StreamEvent,
  TodoItem,
} from "@cna/shared";
import { messageText, messageThinking, messageToolCalls, toolResultText } from "@cna/shared/client";

export type TranscriptItem =
  | { kind: "user"; key: string; text: string }
  | {
      kind: "assistant";
      key: string;
      text: string;
      thinking: string;
      streaming: boolean;
      error?: string;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      status: "running" | "done" | "error";
      output: string;
      durationMs?: number;
    }
  | { kind: "notice"; key: string; level: "info" | "warning" | "error"; text: string };

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type NoticeLevel = "info" | "warning" | "error";

export interface ViewState {
  session: SessionInfo | null;
  transcript: TranscriptItem[];
  questions: Question[];
  todos: TodoItem[];
  checkpoints: Checkpoint[];
  network: NetworkLogEntry[];
  /** The replay missed events (`: truncated`); the UI offers to reload the conversation. */
  truncated: boolean;
  lastEventId: number;
  /** Counter for TranscriptItem keys: each new item gets key `String(nextKey)` and increments it. */
  nextKey: number;
}

/** Max entries kept in `network` (the oldest are dropped). */
export const NETWORK_VIEW_LIMIT = 500;

export const initialViewState: ViewState = {
  session: null,
  transcript: [],
  questions: [],
  todos: [],
  checkpoints: [],
  network: [],
  truncated: false,
  lastEventId: 0,
  nextKey: 1,
};

export type ViewAction =
  | { type: "event"; event: StreamEvent }
  /** New gateway process: drop everything (back to initialViewState). */
  | { type: "reset" }
  | { type: "truncated" }
  /** GET /session. Also sets `questions` to `session?.pendingQuestions ?? []`. */
  | { type: "session"; session: SessionInfo | null }
  /** GET /session/messages: rebuilds `transcript` and clears `truncated`. */
  | { type: "messages"; messages: PiMessage[] }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "checkpoints"; checkpoints: Checkpoint[] }
  /** GET /network/log: replaces `network` (keeps the last NETWORK_VIEW_LIMIT). */
  | { type: "networkLog"; entries: NetworkLogEntry[] };

/** Pure: never mutates `state`; slices that do not change keep their identity (===). */
export function reduceView(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "reset":
      return initialViewState;
    case "truncated":
      return patch(state, { truncated: true });
    case "session": {
      const pending = action.session?.pendingQuestions ?? [];
      return patch(state, {
        session: action.session,
        questions: sameQuestions(state.questions, pending) ? state.questions : pending,
      });
    }
    case "messages": {
      const rebuilt = rebuildTranscript(action.messages, state.nextKey);
      return patch(state, {
        transcript: rebuilt.transcript,
        nextKey: rebuilt.nextKey,
        truncated: false,
      });
    }
    case "todos":
      return patch(state, { todos: action.todos });
    case "checkpoints":
      return patch(state, { checkpoints: action.checkpoints });
    case "networkLog":
      return patch(state, { network: action.entries.slice(-NETWORK_VIEW_LIMIT) });
  }
}

/** Returns `state` itself when no field really changes; otherwise a new object. */
function patch(state: ViewState, changes: Partial<ViewState>): ViewState {
  const keys = Object.keys(changes) as (keyof ViewState)[];
  if (keys.every((key) => changes[key] === state[key])) {
    return state;
  }
  return { ...state, ...changes };
}

function applyEvent(state: ViewState, streamEvent: StreamEvent): ViewState {
  const next = applySessionEvent(state, streamEvent.event);
  return patch(next, { lastEventId: streamEvent.id });
}

function applySessionEvent(state: ViewState, event: StreamEvent["event"]): ViewState {
  switch (event.type) {
    case "status": {
      let next = state;
      if (state.session) {
        next = patch(state, { session: withStatus(state.session, event.status, event.error) });
      }
      if (event.status === "error") {
        const text = event.error ? `La sesión falló: ${event.error}` : "La sesión falló";
        next = addNotice(next, "error", text);
      }
      return next;
    }
    case "message_delta":
      return applyDelta(state, "text", event.delta);
    case "thinking_delta":
      return applyDelta(state, "thinking", event.delta);
    case "message":
      return applyMessage(state, event.message);
    case "tool_start":
      return applyToolStart(state, event.toolCallId, event.toolName, event.args);
    case "tool_update":
      return applyToolUpdate(state, event.toolCallId, event.partialResult);
    case "tool_end":
      return applyToolEnd(
        state,
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError,
        event.durationMs,
      );
    case "question":
      if (state.questions.some((question) => question.id === event.question.id)) {
        return state;
      }
      return patch(state, { questions: [...state.questions, event.question] });
    case "question_resolved": {
      if (!state.questions.some((question) => question.id === event.questionId)) {
        return state;
      }
      return patch(state, {
        questions: state.questions.filter((question) => question.id !== event.questionId),
      });
    }
    case "todo":
      return patch(state, { todos: event.todos });
    case "checkpoint":
      return applyCheckpoint(state, event.action, event.checkpoint);
    case "mode":
      if (!state.session || state.session.mode === event.mode) {
        return state;
      }
      return patch(state, { session: { ...state.session, mode: event.mode } });
    case "network":
      return patch(state, { network: [...state.network, event.entry].slice(-NETWORK_VIEW_LIMIT) });
    case "compaction":
      return applyCompaction(state, event);
    case "retry":
      return applyRetry(state, event);
    case "notify":
      return addNotice(state, event.level, event.message);
    case "error":
      return addNotice(state, "error", event.message);
  }
}

function withStatus(
  session: SessionInfo,
  status: SessionInfo["status"],
  error: string | undefined,
): SessionInfo {
  if (session.status === status && session.error === error) {
    return session;
  }
  const { error: _previousError, ...rest } = session;
  return { ...rest, status, ...(error !== undefined ? { error } : {}) };
}

function applyCheckpoint(
  state: ViewState,
  action: "created" | "restored",
  checkpoint: Checkpoint,
): ViewState {
  if (action === "restored") {
    return addNotice(state, "info", `Restaurado el checkpoint #${checkpoint.id}`);
  }
  if (state.checkpoints.some((existing) => existing.id === checkpoint.id)) {
    return state;
  }
  const checkpoints = [...state.checkpoints, checkpoint].sort((a, b) => a.id - b.id);
  return patch(state, { checkpoints });
}

function applyCompaction(
  state: ViewState,
  event: Extract<StreamEvent["event"], { type: "compaction" }>,
): ViewState {
  if (event.phase === "start") {
    return addNotice(state, "info", "Compactando el contexto…");
  }
  if (event.error) {
    return addNotice(state, "warning", `La compactación falló: ${event.error}`);
  }
  if (event.aborted) {
    return addNotice(state, "warning", "Compactación cancelada");
  }
  return addNotice(state, "info", "Contexto compactado");
}

function applyRetry(
  state: ViewState,
  event: Extract<StreamEvent["event"], { type: "retry" }>,
): ViewState {
  if (event.phase === "start") {
    return addNotice(
      state,
      "warning",
      `Reintentando (${event.attempt}/${event.maxAttempts ?? "?"})…`,
    );
  }
  if (event.success === false) {
    return addNotice(state, "error", `El reintento falló: ${event.error || "sin detalle"}`);
  }
  return state;
}

/** Appends a new item, taking the next key from `nextKey`. */
function appendItem(state: ViewState, make: (key: string) => TranscriptItem): ViewState {
  return patch(state, {
    transcript: [...state.transcript, make(String(state.nextKey))],
    nextKey: state.nextKey + 1,
  });
}

function addNotice(state: ViewState, level: NoticeLevel, text: string): ViewState {
  return appendItem(state, (key) => ({ kind: "notice", key, level, text }));
}

function makeAssistant(
  key: string,
  text: string,
  thinking: string,
  streaming: boolean,
  error: string | undefined,
): AssistantItem {
  return {
    kind: "assistant",
    key,
    text,
    thinking,
    streaming,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Index of the last assistant item still streaming, or -1. */
function lastStreamingIndex(transcript: TranscriptItem[]): number {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const item = transcript[index];
    if (item?.kind === "assistant" && item.streaming) {
      return index;
    }
  }
  return -1;
}

function applyDelta(state: ViewState, field: "text" | "thinking", delta: string): ViewState {
  const index = lastStreamingIndex(state.transcript);
  if (index === -1) {
    return appendItem(state, (key) =>
      makeAssistant(
        key,
        field === "text" ? delta : "",
        field === "thinking" ? delta : "",
        true,
        undefined,
      ),
    );
  }
  const item = state.transcript[index] as AssistantItem;
  const updated: AssistantItem =
    field === "text"
      ? { ...item, text: item.text + delta }
      : { ...item, thinking: item.thinking + delta };
  return patch(state, { transcript: state.transcript.with(index, updated) });
}

function applyMessage(state: ViewState, message: PiMessage): ViewState {
  if (message.role === "user") {
    const text = messageText(message);
    return appendItem(state, (key) => ({ kind: "user", key, text }));
  }
  if (message.role !== "assistant") {
    return state;
  }
  const text = messageText(message);
  const thinking = messageThinking(message);
  const error =
    typeof message.errorMessage === "string" && message.errorMessage !== ""
      ? message.errorMessage
      : undefined;
  const index = lastStreamingIndex(state.transcript);
  const hasContent = text !== "" || thinking !== "" || error !== undefined;

  if (!hasContent) {
    // A message that only calls tools: drop the streaming placeholder, add nothing.
    if (index === -1) {
      return state;
    }
    return patch(state, { transcript: state.transcript.toSpliced(index, 1) });
  }
  if (index !== -1) {
    const previous = state.transcript[index] as AssistantItem;
    const final = makeAssistant(previous.key, text, thinking, false, error);
    return patch(state, { transcript: state.transcript.with(index, final) });
  }
  return appendItem(state, (key) => makeAssistant(key, text, thinking, false, error));
}

function findToolIndex(transcript: TranscriptItem[], toolCallId: string): number {
  return transcript.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
}

function applyToolStart(
  state: ViewState,
  toolCallId: string,
  toolName: string,
  args: unknown,
): ViewState {
  const index = findToolIndex(state.transcript, toolCallId);
  if (index === -1) {
    return appendItem(state, (key) => ({
      kind: "tool",
      key,
      toolCallId,
      toolName,
      args,
      status: "running",
      output: "",
    }));
  }
  const existing = state.transcript[index] as ToolItem;
  const updated: ToolItem = {
    kind: "tool",
    key: existing.key,
    toolCallId,
    toolName,
    args,
    status: "running",
    output: "",
  };
  return patch(state, { transcript: state.transcript.with(index, updated) });
}

function applyToolUpdate(state: ViewState, toolCallId: string, partialResult: unknown): ViewState {
  const index = findToolIndex(state.transcript, toolCallId);
  if (index === -1) {
    return state;
  }
  const existing = state.transcript[index] as ToolItem;
  const output = toolResultText(partialResult);
  if (existing.output === output) {
    return state;
  }
  return patch(state, { transcript: state.transcript.with(index, { ...existing, output }) });
}

function applyToolEnd(
  state: ViewState,
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
  durationMs: number | undefined,
): ViewState {
  const status: ToolItem["status"] = isError ? "error" : "done";
  const index = findToolIndex(state.transcript, toolCallId);
  if (index === -1) {
    return appendItem(state, (key) => ({
      kind: "tool",
      key,
      toolCallId,
      toolName,
      args: undefined,
      status,
      output: toolResultText(result),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }));
  }
  const existing = state.transcript[index] as ToolItem;
  const effectiveDuration = durationMs ?? existing.durationMs;
  const updated: ToolItem = {
    kind: "tool",
    key: existing.key,
    toolCallId: existing.toolCallId,
    toolName: existing.toolName,
    args: existing.args,
    status,
    output: toolResultText(result),
    ...(effectiveDuration !== undefined ? { durationMs: effectiveDuration } : {}),
  };
  return patch(state, { transcript: state.transcript.with(index, updated) });
}

function sameQuestions(a: Question[], b: Question[]): boolean {
  return (
    a.length === b.length &&
    a.every((question, index) => JSON.stringify(question) === JSON.stringify(b[index]))
  );
}

/** Rebuilds the transcript from GET /session/messages. Keys continue from `startKey`. */
function rebuildTranscript(
  messages: PiMessage[],
  startKey: number,
): { transcript: TranscriptItem[]; nextKey: number } {
  const transcript: TranscriptItem[] = [];
  let nextKey = startKey;
  const newKey = (): string => String(nextKey++);

  for (const message of messages) {
    if (message.role === "user") {
      transcript.push({ kind: "user", key: newKey(), text: messageText(message) });
    } else if (message.role === "assistant") {
      const text = messageText(message);
      const thinking = messageThinking(message);
      const error =
        typeof message.errorMessage === "string" && message.errorMessage !== ""
          ? message.errorMessage
          : undefined;
      if (text !== "" || thinking !== "" || error !== undefined) {
        transcript.push(makeAssistant(newKey(), text, thinking, false, error));
      }
      for (const call of messageToolCalls(message)) {
        transcript.push({
          kind: "tool",
          key: newKey(),
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
          status: "running",
          output: "",
        });
      }
    } else if (message.role === "toolResult") {
      const index = transcript.findLastIndex(
        (item) => item.kind === "tool" && item.toolCallId === message.toolCallId,
      );
      const existing = transcript[index];
      if (existing?.kind === "tool") {
        transcript[index] = {
          ...existing,
          output: toolResultText(message),
          status: message.isError === true ? "error" : "done",
        };
      }
    }
  }
  return { transcript, nextKey };
}
