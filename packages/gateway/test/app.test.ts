import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Checkpoint,
  DiffResponse,
  ModelsResponse,
  PiMessage,
  Question,
  SessionEvent,
  SessionInfo,
  SessionStats,
  TodoItem,
} from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppOptions, createApp } from "../src/app.js";
import { EventLog } from "../src/events/event-log.js";
import { SessionError, type SessionService } from "../src/session/service.js";

const SESSION: SessionInfo = {
  id: "s1",
  status: "running",
  repo: "octo/demo",
  baseBranch: "main",
  branch: "agent/demo",
  model: null,
  thinking: null,
  mode: "auto",
  autoPush: false,
  createdAt: "2026-11-16T10:00:00.000Z",
  pr: null,
  suspended: false,
  pendingQuestions: [],
};

const MODELS: ModelsResponse = {
  default: "mock/model-a",
  models: [{ ref: "mock/model-a", provider: "mock", modelId: "model-a" }],
};

const NETWORK_QUESTION: Question = {
  id: "net-1",
  kind: "network",
  method: "select",
  title: "Allow host?",
  options: ["allow_once", "allow_always", "deny"],
  timeoutMs: 60_000,
  createdAt: "2026-11-16T10:00:00.000Z",
  network: { host: "example.com", port: 443 },
};

const CHECKPOINT: Checkpoint = {
  id: 2,
  commit: "a".repeat(40),
  createdAt: "2026-11-16T10:00:00.000Z",
  reason: "run",
};

const DIFF: DiffResponse = {
  from: { kind: "base", branch: "main", commit: "b".repeat(40) },
  files: [{ path: "README.md", status: "modified", additions: 1, deletions: 1 }],
  patch: "@@ -1 +1 @@\n-hello\n+changed\n",
  truncated: false,
};

const STATS: SessionStats = {
  tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126 },
  cost: 0.0123,
  messages: { user: 2, assistant: 3, toolCalls: 4 },
  context: { tokens: 1200, window: 32000, percent: 3.75 },
};

const NETWORK_ENTRY = {
  ts: "2026-11-16T10:00:00.000Z",
  method: "CONNECT" as const,
  host: "example.com",
  port: 443,
  decision: "allow" as const,
  reason: "allowlist" as const,
  bytesOut: 10,
  bytesIn: 20,
  durationMs: 5,
};

/** Fake SessionService: every method is a vi.fn with a harmless default. */
function fakeSession(overrides: Partial<SessionService> = {}) {
  const service = {
    get: vi.fn(() => null),
    create: vi.fn(async () => SESSION),
    postMessage: vi.fn(async () => ({ disposition: "started" as const })),
    answer: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    messages: vi.fn(async (): Promise<PiMessage[]> => []),
    stats: vi.fn(async (): Promise<SessionStats> => STATS),
    checkpoints: vi.fn((): Checkpoint[] => [CHECKPOINT]),
    restoreCheckpoint: vi.fn(async (id: number, options: { conversation: boolean }) => ({
      checkpoint: { ...CHECKPOINT, id },
      conversationRestored: options.conversation,
    })),
    diff: vi.fn(async (): Promise<DiffResponse> => DIFF),
    close: vi.fn(async () => {}),
    publishNetworkQuestion: vi.fn(() => true),
    resolveNetworkQuestion: vi.fn(() => true),
    publishNetworkEntry: vi.fn(() => {}),
    ...overrides,
  };
  return service as typeof service & SessionService;
}

function build(overrides: Partial<AppOptions> = {}) {
  const session = fakeSession();
  const events = new EventLog();
  const app = createApp({
    version: "1.2.3",
    session,
    events,
    models: () => MODELS,
    ...overrides,
  });
  return { app, session, events };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /health", () => {
  it("returns the health body as JSON", async () => {
    const { app } = build({ version: "1.2.3" });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", service: "gateway", version: "1.2.3" });
  });
});

describe("unknown routes", () => {
  it("answers POST /health with 404 not_found", async () => {
    const { app } = build();

    const res = await app.request("/health", { method: "POST" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers GET /nope with 404 not_found", async () => {
    const { app } = build();

    const res = await app.request("/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /models", () => {
  it("returns the body of models()", async () => {
    const { app } = build();

    const res = await app.request("/models");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MODELS);
  });
});

describe("GET /session", () => {
  it("answers 404 no_session when there is no session", async () => {
    const { app } = build();

    const res = await app.request("/session");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_session" });
  });

  it("answers 200 with the session info", async () => {
    const session = fakeSession({ get: vi.fn(() => SESSION) });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SESSION);
  });
});

describe("POST /session", () => {
  it("answers 201 and passes the validated body to create()", async () => {
    const { app, session } = build();
    const body = { repo: "octo/demo", prompt: "fix the tests", autoPush: true };

    const res = await app.request("/session", jsonRequest("POST", body));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(SESSION);
    expect(session.create).toHaveBeenCalledWith(body);
  });

  it("answers 400 invalid_request for a body that is not JSON", async () => {
    const { app, session } = build();

    const res = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("invalid_request");
    expect(json.message).toBeTypeOf("string");
    expect(session.create).not.toHaveBeenCalled();
  });

  it("answers 400 with a repo: message for an invalid repository", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/session",
      jsonRequest("POST", { repo: "not-a-repo", prompt: "hi" }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("invalid_request");
    expect(json.message.startsWith("repo:")).toBe(true);
    expect(session.create).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown field", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/session",
      jsonRequest("POST", { repo: "octo/demo", prompt: "hi", extra: true }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(session.create).not.toHaveBeenCalled();
  });

  it("answers 409 session_exists when create() throws it", async () => {
    const session = fakeSession({
      create: vi.fn(async () => {
        throw new SessionError("session_exists", "a session is active");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request(
      "/session",
      jsonRequest("POST", { repo: "octo/demo", prompt: "hi" }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "session_exists", message: "a session is active" });
  });

  it("answers 400 mode_not_supported when create() throws it", async () => {
    const session = fakeSession({
      create: vi.fn(async () => {
        throw new SessionError("mode_not_supported");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request(
      "/session",
      jsonRequest("POST", { repo: "octo/demo", prompt: "hi", mode: "plan" }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("mode_not_supported");
  });
});

describe("POST /session/messages", () => {
  it("answers 200 with the disposition", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/session/messages",
      jsonRequest("POST", { text: "continue", mode: "steer" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disposition: "started" });
    expect(session.postMessage).toHaveBeenCalledWith({ text: "continue", mode: "steer" });
  });

  it("answers 409 invalid_state when postMessage() throws it", async () => {
    const session = fakeSession({
      postMessage: vi.fn(async () => {
        throw new SessionError("invalid_state");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/messages", jsonRequest("POST", { text: "hi" }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_state");
  });

  it("answers 400 for an empty text", async () => {
    const { app, session } = build();

    const res = await app.request("/session/messages", jsonRequest("POST", { text: "" }));

    expect(res.status).toBe(400);
    expect(session.postMessage).not.toHaveBeenCalled();
  });
});

describe("POST /session/answers/:questionId", () => {
  it("answers 204 and passes the id and the answer", async () => {
    const { app, session } = build();

    const res = await app.request("/session/answers/q1", jsonRequest("POST", { value: "a" }));

    expect(res.status).toBe(204);
    expect(session.answer).toHaveBeenCalledWith("q1", { value: "a" });
  });

  it("answers 400 for an empty answer", async () => {
    const { app, session } = build();

    const res = await app.request("/session/answers/q1", jsonRequest("POST", {}));

    expect(res.status).toBe(400);
    expect(session.answer).not.toHaveBeenCalled();
  });

  it("answers 404 question_not_found when answer() throws it", async () => {
    const session = fakeSession({
      answer: vi.fn(async () => {
        throw new SessionError("question_not_found");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/answers/q1", jsonRequest("POST", { confirmed: true }));

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("question_not_found");
  });

  it("answers 409 question_resolved when answer() throws it", async () => {
    const session = fakeSession({
      answer: vi.fn(async () => {
        throw new SessionError("question_resolved");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/answers/q1", jsonRequest("POST", { cancelled: true }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("question_resolved");
  });
});

describe("PUT /session/model", () => {
  it("answers 204 and passes the request to setModel()", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/session/model",
      jsonRequest("PUT", { model: "mock/model-a", thinking: "high" }),
    );

    expect(res.status).toBe(204);
    expect(session.setModel).toHaveBeenCalledWith({ model: "mock/model-a", thinking: "high" });
  });

  it("answers 400 unknown_model when setModel() throws it", async () => {
    const session = fakeSession({
      setModel: vi.fn(async () => {
        throw new SessionError("unknown_model");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/model", jsonRequest("PUT", { model: "x/y" }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_model");
  });
});

describe("POST /session/abort", () => {
  it("answers 204 and calls abort()", async () => {
    const { app, session } = build();

    const res = await app.request("/session/abort", { method: "POST" });

    expect(res.status).toBe(204);
    expect(session.abort).toHaveBeenCalledOnce();
  });
});

describe("DELETE /session", () => {
  it("closes without force by default", async () => {
    const { app, session } = build();

    const res = await app.request("/session", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(session.close).toHaveBeenCalledWith({ force: false });
  });

  it("closes with force for ?force=true", async () => {
    const { app, session } = build();

    const res = await app.request("/session?force=true", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(session.close).toHaveBeenCalledWith({ force: true });
  });

  it("does not force for any other value", async () => {
    const { app, session } = build();

    const res = await app.request("/session?force=1", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(session.close).toHaveBeenCalledWith({ force: false });
  });
});

describe("GET /session/todos", () => {
  it("answers 200 with { todos } from todos()", async () => {
    const todos: TodoItem[] = [
      { id: 1, text: "Read the code", status: "completed" },
      { id: 2, text: "Write the tests", status: "in_progress" },
    ];
    const session = fakeSession({ todos: vi.fn(() => todos) });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/todos");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ todos });
  });

  it("answers 404 no_session when there is no session", async () => {
    const session = fakeSession({
      todos: vi.fn(() => {
        throw new SessionError("no_session");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/todos");

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_session");
  });
});

describe("GET /session/messages", () => {
  it("answers { messages } from messages()", async () => {
    const messages: PiMessage[] = [{ role: "user", content: "hi" }];
    const session = fakeSession({ messages: vi.fn(async () => messages) });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/messages");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages });
  });
});

describe("GET /session/events", () => {
  it("streams the events after Last-Event-ID", async () => {
    const { app, events } = build();
    const notify = (message: string): SessionEvent => ({ type: "notify", level: "info", message });
    events.append(notify("first"));
    events.append(notify("second"));
    const controller = new AbortController();

    const res = await app.request("/session/events", {
      signal: controller.signal,
      headers: { "Last-Event-ID": "1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let text = "";
    while (!/^id: 2$/m.test(text)) {
      const next = await reader?.read();
      if (next === undefined || next.done) {
        break;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    controller.abort();
    await reader?.cancel().catch(() => {});

    expect(text).toMatch(/^id: 2$/m);
    expect(text).not.toMatch(/^id: 1$/m);
  });

  it("works without a session", async () => {
    const { app } = build();
    const controller = new AbortController();

    const res = await app.request("/session/events", { signal: controller.signal });

    expect(res.status).toBe(200);
    controller.abort();
    await res.body?.cancel().catch(() => {});
  });
});

describe("internal routes", () => {
  it("POST /internal/questions answers 201 when the question is published", async () => {
    const { app, session } = build({});
    vi.mocked(session.publishNetworkQuestion).mockReturnValue(true);

    const res = await app.request(
      "/internal/questions",
      jsonRequest("POST", { question: NETWORK_QUESTION }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({});
    expect(session.publishNetworkQuestion).toHaveBeenCalledWith(NETWORK_QUESTION);
  });

  it("POST /internal/questions answers 409 no_session without an active session", async () => {
    const { app, session } = build();
    vi.mocked(session.publishNetworkQuestion).mockReturnValue(false);

    const res = await app.request(
      "/internal/questions",
      jsonRequest("POST", { question: NETWORK_QUESTION }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_session" });
  });

  it("POST /internal/questions rejects an id without the net- prefix", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/internal/questions",
      jsonRequest("POST", { question: { ...NETWORK_QUESTION, id: "q1" } }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(session.publishNetworkQuestion).not.toHaveBeenCalled();
  });

  it("POST /internal/questions/:id/resolved answers 204 when resolved", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/internal/questions/net-1/resolved",
      jsonRequest("POST", { outcome: "timeout" }),
    );

    expect(res.status).toBe(204);
    expect(session.resolveNetworkQuestion).toHaveBeenCalledWith("net-1", "timeout");
  });

  it("POST /internal/questions/:id/resolved answers 404 when the question is unknown", async () => {
    const { app, session } = build();
    vi.mocked(session.resolveNetworkQuestion).mockReturnValue(false);

    const res = await app.request(
      "/internal/questions/net-9/resolved",
      jsonRequest("POST", { outcome: "answered" }),
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("question_not_found");
  });

  it("POST /internal/network answers 204 and passes the entry", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/internal/network",
      jsonRequest("POST", { entry: NETWORK_ENTRY }),
    );

    expect(res.status).toBe(204);
    expect(session.publishNetworkEntry).toHaveBeenCalledWith(NETWORK_ENTRY);
  });
});

describe("GET /session/stats", () => {
  it("answers 200 with the body of stats()", async () => {
    const { app, session } = build();

    const res = await app.request("/session/stats");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATS);
    expect(session.stats).toHaveBeenCalledOnce();
  });

  it("answers 404 no_session when stats() throws it", async () => {
    const session = fakeSession({
      stats: vi.fn(async () => {
        throw new SessionError("no_session");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/stats");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_session", message: "no_session" });
  });
});

describe("GET /session/checkpoints", () => {
  it("answers 200 with { checkpoints } from checkpoints()", async () => {
    const { app, session } = build();

    const res = await app.request("/session/checkpoints");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkpoints: [CHECKPOINT] });
    expect(session.checkpoints).toHaveBeenCalledOnce();
  });

  it("answers 404 no_session when there is no session", async () => {
    const session = fakeSession({
      checkpoints: vi.fn(() => {
        throw new SessionError("no_session");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/checkpoints");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_session", message: "no_session" });
  });
});

describe("POST /session/checkpoints/:id/restore", () => {
  it("answers 200 and passes the id and the conversation flag", async () => {
    const { app, session } = build();

    const res = await app.request(
      "/session/checkpoints/3/restore",
      jsonRequest("POST", { conversation: true }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkpoint: { ...CHECKPOINT, id: 3 },
      conversationRestored: true,
    });
    expect(session.restoreCheckpoint).toHaveBeenCalledWith(3, { conversation: true });
  });

  it("treats an empty body as { conversation: false } (files only)", async () => {
    const { app, session } = build();

    const withoutBody = await app.request("/session/checkpoints/0/restore", { method: "POST" });
    const blankBody = await app.request("/session/checkpoints/0/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "  ",
    });

    expect(withoutBody.status).toBe(200);
    expect(blankBody.status).toBe(200);
    expect(session.restoreCheckpoint).toHaveBeenNthCalledWith(1, 0, { conversation: false });
    expect(session.restoreCheckpoint).toHaveBeenNthCalledWith(2, 0, { conversation: false });
  });

  it("answers 400 for an id that is not a canonical non-negative integer", async () => {
    const { app, session } = build();

    for (const id of ["abc", "01", "-1", "1.5"]) {
      const res = await app.request(`/session/checkpoints/${id}/restore`, { method: "POST" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
    expect(session.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that does not match the schema or is not JSON", async () => {
    const { app, session } = build();

    const wrongType = await app.request(
      "/session/checkpoints/1/restore",
      jsonRequest("POST", { conversation: "x" }),
    );
    const extraField = await app.request(
      "/session/checkpoints/1/restore",
      jsonRequest("POST", { conversation: true, force: true }),
    );
    const notJson = await app.request("/session/checkpoints/1/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(wrongType.status).toBe(400);
    expect(extraField.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(session.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("answers 404 checkpoint_not_found when the service throws it", async () => {
    const session = fakeSession({
      restoreCheckpoint: vi.fn(async () => {
        throw new SessionError("checkpoint_not_found");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/checkpoints/9/restore", { method: "POST" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "checkpoint_not_found",
      message: "checkpoint_not_found",
    });
  });

  it("answers 409 invalid_state when the service throws it", async () => {
    const session = fakeSession({
      restoreCheckpoint: vi.fn(async () => {
        throw new SessionError("invalid_state", "fork cancelled");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/checkpoints/1/restore", { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid_state", message: "fork cancelled" });
  });
});

describe("GET /session/diff", () => {
  it("answers 200 with the diff against the base branch when there is no checkpoint", async () => {
    const { app, session } = build();

    const res = await app.request("/session/diff");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DIFF);
    expect(session.diff).toHaveBeenCalledWith(undefined);
  });

  it("passes the checkpoint id of ?checkpoint=", async () => {
    const { app, session } = build();

    const res = await app.request("/session/diff?checkpoint=0");

    expect(res.status).toBe(200);
    expect(session.diff).toHaveBeenCalledWith(0);
  });

  it("answers 400 for a checkpoint that is not a canonical non-negative integer", async () => {
    const { app, session } = build();

    for (const value of ["x", "01", "", "-2"]) {
      const res = await app.request(`/session/diff?checkpoint=${value}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
    expect(session.diff).not.toHaveBeenCalled();
  });

  it("answers 404 checkpoint_not_found when the service throws it", async () => {
    const session = fakeSession({
      diff: vi.fn(async () => {
        throw new SessionError("checkpoint_not_found");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request("/session/diff?checkpoint=7");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "checkpoint_not_found",
      message: "checkpoint_not_found",
    });
  });
});

describe("unhandled errors", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("answers 500 internal_error without leaking the message", async () => {
    const { app } = build();
    app.get("/boom", () => {
      throw new Error("secret detail");
    });

    const res = await app.request("/boom");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("secret detail");
    expect(consoleError).toHaveBeenCalled();
  });

  it("answers 500 for a service failure and logs only the error message, not the body", async () => {
    const session = fakeSession({
      postMessage: vi.fn(async () => {
        throw new Error("upstream exploded");
      }),
    });
    const app = createApp({ version: "1", session, events: new EventLog(), models: () => MODELS });

    const res = await app.request(
      "/session/messages",
      jsonRequest("POST", { text: "my GITHUB_TOKEN=ghp_secret" }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    const logged = consoleError.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("upstream exploded");
    expect(logged).not.toContain("ghp_secret");
  });
});

describe("body size limit", () => {
  it("answers 413 for a body larger than 1 MiB", async () => {
    const { app, session } = build();
    const text = "a".repeat(1024 * 1024 + 1);

    const res = await app.request("/session/messages", jsonRequest("POST", { text }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "invalid_request", message: "body too large" });
    expect(session.postMessage).not.toHaveBeenCalled();
  });
});

describe("web UI mounting", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cna-app-web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>cna</title>");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves /ui/ when webUiDir is set", async () => {
    const app = createApp({
      version: "1",
      session: fakeSession(),
      events: new EventLog(),
      models: () => MODELS,
      webUiDir: dir,
    });

    const res = await app.request("/ui/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>cna</title>");
  });

  it("answers /ui/ with not_found JSON when webUiDir is absent", async () => {
    const app = createApp({
      version: "1",
      session: fakeSession(),
      events: new EventLog(),
      models: () => MODELS,
    });

    const res = await app.request("/ui/");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
