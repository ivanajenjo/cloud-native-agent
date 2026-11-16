import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  normalizeRpcEvent,
  type RpcEvent,
  uiRequestToNotify,
  uiRequestToQuestion,
} from "../src/session/normalize.js";

const NOW = new Date("2026-11-16T10:00:00.000Z");

describe("normalizeRpcEvent", () => {
  it("maps text_delta to message_delta", () => {
    const event: RpcEvent = {
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    };
    expect(normalizeRpcEvent(event)).toEqual([
      { type: "message_delta", contentIndex: 0, delta: "Hello " },
    ]);
  });

  it("maps thinking_delta to thinking_delta", () => {
    const event: RpcEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
    };
    expect(normalizeRpcEvent(event)).toEqual([
      { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
    ]);
  });

  it("ignores other message_update subtypes", () => {
    const subtypes = [
      { type: "text_start", contentIndex: 0 },
      { type: "toolcall_delta", contentIndex: 2, delta: '{"command"' },
      { type: "text_end", contentIndex: 0, content: "Hello" },
      { type: "done", reason: "stop", message: {} },
    ];
    for (const assistantMessageEvent of subtypes) {
      expect(normalizeRpcEvent({ type: "message_update", assistantMessageEvent })).toEqual([]);
    }
  });

  it("maps message_end to the authoritative message", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
    expect(normalizeRpcEvent({ type: "message_end", message })).toEqual([
      { type: "message", message },
    ]);
  });

  it("maps tool_execution_start to tool_start", () => {
    const event: RpcEvent = {
      type: "tool_execution_start",
      toolCallId: "call_abc123",
      toolName: "bash",
      args: { command: "ls -la" },
    };
    expect(normalizeRpcEvent(event)).toEqual([
      {
        type: "tool_start",
        toolCallId: "call_abc123",
        toolName: "bash",
        args: { command: "ls -la" },
      },
    ]);
  });

  it("maps tool_execution_update to tool_update", () => {
    const event: RpcEvent = {
      type: "tool_execution_update",
      toolCallId: "call_abc123",
      toolName: "bash",
      args: { command: "ls -la" },
      partialResult: { content: [{ type: "text", text: "partial output" }], details: {} },
    };
    expect(normalizeRpcEvent(event)).toEqual([
      {
        type: "tool_update",
        toolCallId: "call_abc123",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "partial output" }], details: {} },
      },
    ]);
  });

  it("maps tool_execution_end to tool_end with durationMs when present", () => {
    const event: RpcEvent = {
      type: "tool_execution_end",
      toolCallId: "call_abc123",
      toolName: "bash",
      result: { content: [{ type: "text", text: "complete output" }], details: {} },
      isError: false,
      durationMs: 42,
    };
    const [sse] = normalizeRpcEvent(event);
    expect(sse).toEqual({
      type: "tool_end",
      toolCallId: "call_abc123",
      toolName: "bash",
      result: { content: [{ type: "text", text: "complete output" }], details: {} },
      isError: false,
      durationMs: 42,
    });
    expect(sse).toHaveProperty("durationMs", 42);
  });

  it("omits durationMs in tool_end when Pi does not send it", () => {
    const event: RpcEvent = {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: "denied",
      isError: true,
    };
    const [sse] = normalizeRpcEvent(event);
    expect(sse).toEqual({
      type: "tool_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: "denied",
      isError: true,
    });
    expect(sse).not.toHaveProperty("durationMs");
  });

  it("maps compaction_start and compaction_end", () => {
    expect(normalizeRpcEvent({ type: "compaction_start", reason: "threshold" })).toEqual([
      { type: "compaction", phase: "start", reason: "threshold" },
    ]);
    expect(
      normalizeRpcEvent({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "..." },
        aborted: false,
        willRetry: false,
      }),
    ).toEqual([{ type: "compaction", phase: "end", reason: "threshold", aborted: false }]);
  });

  it("maps a failed compaction_end with its error message and no undefined keys", () => {
    const [sse] = normalizeRpcEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      errorMessage: "summary failed",
    });
    expect(sse).toEqual({
      type: "compaction",
      phase: "end",
      reason: "manual",
      aborted: false,
      error: "summary failed",
    });
  });

  it("maps auto_retry_start and auto_retry_end", () => {
    expect(
      normalizeRpcEvent({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "529 overloaded",
      }),
    ).toEqual([
      {
        type: "retry",
        phase: "start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        error: "529 overloaded",
      },
    ]);
    expect(normalizeRpcEvent({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([
      { type: "retry", phase: "end", attempt: 2, success: true },
    ]);
    expect(
      normalizeRpcEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "boom" }),
    ).toEqual([{ type: "retry", phase: "end", attempt: 3, success: false, error: "boom" }]);
  });

  it("maps extension_error without the extension path", () => {
    const [sse] = normalizeRpcEvent({
      type: "extension_error",
      extensionPath: "/home/pi/.pi/extensions/secret/index.ts",
      event: "tool_call",
      error: "Error message",
    });
    expect(sse).toEqual({ type: "error", message: "extension error: Error message" });
    expect(JSON.stringify(sse)).not.toContain("/home/pi");
  });

  it("ignores run-state and bookkeeping events", () => {
    const events: RpcEvent[] = [
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: true },
      { type: "agent_settled", aborted: false },
      { type: "turn_start" },
      { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "entry_appended", entry: { type: "custom" } },
      { type: "some_future_event" },
    ];
    for (const event of events) {
      expect(normalizeRpcEvent(event)).toEqual([]);
    }
  });

  it("only auto_retry_start produces output among agent_end, auto_retry_start and agent_settled", () => {
    const sequence: RpcEvent[] = [
      { type: "agent_end", messages: [], willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "503" },
      { type: "agent_settled", aborted: false },
    ];
    const outputs = sequence.map((event) => normalizeRpcEvent(event));
    expect(outputs[0]).toEqual([]);
    expect(outputs[1]).toEqual([
      {
        type: "retry",
        phase: "start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        error: "503",
      },
    ]);
    expect(outputs[2]).toEqual([]);
  });

  it("returns [] for malformed input without throwing", () => {
    const malformed: RpcEvent[] = [
      { type: "message_update" },
      { type: "message_update", assistantMessageEvent: "text" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
      { type: "tool_execution_end" },
      { type: "tool_execution_start", toolCallId: 7, toolName: "bash" },
      { type: "message_end" },
      { type: "message_end", message: { content: "no role" } },
      { type: "compaction_start" },
      { type: "auto_retry_start" },
      { type: "auto_retry_end" },
      { type: "extension_error" },
    ];
    for (const event of malformed) {
      expect(() => normalizeRpcEvent(event)).not.toThrow();
      expect(normalizeRpcEvent(event)).toEqual([]);
    }
  });
});

describe("uiRequestToQuestion", () => {
  it("reads the kind from the cna:<kind>: prefix of a select title", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "uuid-1",
      method: "select",
      title: "cna:confirm:Push?",
      options: ["Yes", "No"],
    };
    expect(uiRequestToQuestion(request, NOW)).toEqual({
      id: "uuid-1",
      kind: "confirm",
      method: "select",
      title: "Push?",
      options: ["Yes", "No"],
      createdAt: "2026-11-16T10:00:00.000Z",
    });
  });

  it("treats a title without prefix as ask_user", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "uuid-2",
      method: "select",
      title: "Which database?",
      options: ["Postgres", "SQLite"],
    };
    const question = uiRequestToQuestion(request, NOW);
    expect(question?.kind).toBe("ask_user");
    expect(question?.title).toBe("Which database?");
  });

  it("maps confirm with message and timeout", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "uuid-3",
      method: "confirm",
      title: "cna:confirm:Create PR?",
      message: "The branch agent/fix-1 will be pushed.",
      timeout: 5000,
    };
    expect(uiRequestToQuestion(request, NOW)).toEqual({
      id: "uuid-3",
      kind: "confirm",
      method: "confirm",
      title: "Create PR?",
      message: "The branch agent/fix-1 will be pushed.",
      timeoutMs: 5000,
      createdAt: "2026-11-16T10:00:00.000Z",
    });
  });

  it("maps input with placeholder", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "uuid-4",
      method: "input",
      title: "cna:plan:Name",
      placeholder: "type something...",
    };
    expect(uiRequestToQuestion(request, NOW)).toEqual({
      id: "uuid-4",
      kind: "plan",
      method: "input",
      title: "Name",
      placeholder: "type something...",
      createdAt: "2026-11-16T10:00:00.000Z",
    });
  });

  it("maps editor with prefill", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "uuid-5",
      method: "editor",
      title: "cna:ask_user:Edit",
      prefill: "Line 1\nLine 2",
    };
    expect(uiRequestToQuestion(request, NOW)).toEqual({
      id: "uuid-5",
      kind: "ask_user",
      method: "editor",
      title: "Edit",
      prefill: "Line 1\nLine 2",
      createdAt: "2026-11-16T10:00:00.000Z",
    });
  });

  it("omits optional fields that Pi does not send", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "uuid-6",
      method: "input",
      title: "Name",
    };
    const question = uiRequestToQuestion(request, NOW);
    expect(question).not.toHaveProperty("placeholder");
    expect(question).not.toHaveProperty("timeoutMs");
    expect(question).not.toHaveProperty("message");
  });

  it("returns null for fire-and-forget methods", () => {
    const requests = [
      { type: "extension_ui_request", id: "n", method: "notify", message: "hi" },
      {
        type: "extension_ui_request",
        id: "s",
        method: "setStatus",
        statusKey: "k",
        statusText: "running",
      },
      {
        type: "extension_ui_request",
        id: "w",
        method: "setWidget",
        widgetKey: "k",
        widgetLines: ["a"],
      },
      { type: "extension_ui_request", id: "t", method: "setTitle", title: "pi" },
      { type: "extension_ui_request", id: "e", method: "set_editor_text", text: "x" },
    ] as RpcExtensionUIRequest[];
    for (const request of requests) {
      expect(uiRequestToQuestion(request, NOW)).toBeNull();
    }
  });
});

describe("uiRequestToNotify", () => {
  it("defaults the level to info when notifyType is missing", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "n-1",
      method: "notify",
      message: "Command blocked by user",
    };
    expect(uiRequestToNotify(request)).toEqual({
      type: "notify",
      level: "info",
      message: "Command blocked by user",
    });
  });

  it("keeps the notifyType when present", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "n-2",
      method: "notify",
      message: "careful",
      notifyType: "warning",
    };
    expect(uiRequestToNotify(request)).toEqual({
      type: "notify",
      level: "warning",
      message: "careful",
    });
  });

  it("returns null for any other method", () => {
    const request: RpcExtensionUIRequest = {
      type: "extension_ui_request",
      id: "c-1",
      method: "confirm",
      title: "Clear?",
      message: "All messages will be lost.",
    };
    expect(uiRequestToNotify(request)).toBeNull();
  });
});
