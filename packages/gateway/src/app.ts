import {
  type AnswerRequest,
  AnswerRequestSchema,
  type ApiErrorCode,
  type CheckpointsResponse,
  type CreateSessionRequest,
  CreateSessionRequestSchema,
  type DiffResponse,
  type HealthResponse,
  type MessagesResponse,
  type ModelsResponse,
  type PostMessageRequest,
  PostMessageRequestSchema,
  type PublishNetworkEntryRequest,
  PublishNetworkEntryRequestSchema,
  type PublishQuestionRequest,
  PublishQuestionRequestSchema,
  parseCheckpointId,
  type ResolveQuestionRequest,
  ResolveQuestionRequestSchema,
  type RestoreCheckpointRequest,
  RestoreCheckpointRequestSchema,
  type SessionStats,
  type SetModelRequest,
  SetModelRequestSchema,
  type TodosResponse,
} from "@cna/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ZodType, z } from "zod";
import type { EventLog } from "./events/event-log.js";
import { createSseResponse, parseLastEventId } from "./events/sse.js";
import { SessionError, type SessionService } from "./session/service.js";
import { mountWebUi } from "./web-ui.js";

export interface AppOptions {
  version: string;
  session: SessionService;
  events: EventLog;
  /** Body of GET /models. */
  models: () => ModelsResponse;
  /** Passed to createSseResponse. */
  sseHeartbeatMs?: number;
  /** Directory of the built web UI, served under /ui/. Absent means no web UI. */
  webUiDir?: string;
}

/** Maximum size of a request body, in bytes (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

/** HTTP status of each SessionError code. Other codes are answered with 500. */
const SESSION_ERROR_STATUS: Partial<Record<ApiErrorCode, 400 | 404 | 409>> = {
  no_session: 404,
  question_not_found: 404,
  checkpoint_not_found: 404,
  session_exists: 409,
  invalid_state: 409,
  question_resolved: 409,
  invalid_request: 400,
  mode_not_supported: 400,
  unknown_model: 400,
};

/** Thrown when a request body is not JSON or does not match its schema. Answered with 400. */
class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** Reads and validates a JSON body. Throws InvalidRequestError. */
async function parseBody<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new InvalidRequestError("(root): body must be valid JSON");
  }
  return validateBody(raw, schema);
}

/**
 * Like parseBody, but an empty body (or one with only whitespace) is validated as `{}`.
 * Throws InvalidRequestError.
 */
async function parseOptionalBody<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  if (text.trim() === "") {
    return validateBody({}, schema);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InvalidRequestError("(root): body must be valid JSON");
  }
  return validateBody(raw, schema);
}

/** Validates an already parsed JSON value against a schema. Throws InvalidRequestError. */
function validateBody<S extends ZodType>(raw: unknown, schema: S): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "(root)" : issue.path.join(".");
    const detail = issue?.message ?? "invalid body";
    throw new InvalidRequestError(`${path}: ${detail}`);
  }
  return result.data as z.infer<S>;
}

/** Answers 413 for bodies larger than MAX_BODY_BYTES. */
const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "invalid_request", message: "body too large" }, 413),
});

/** Builds the gateway HTTP application. Does not open any port. */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const { session, events } = options;

  app.get("/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      service: "gateway",
      version: options.version,
    };
    return c.json(body);
  });

  app.get("/models", (c) => c.json(options.models()));

  app.get("/session", (c) => {
    const info = session.get();
    if (info === null) {
      return c.json({ error: "no_session" }, 404);
    }
    return c.json(info);
  });

  app.post("/session", limitBody, async (c) => {
    const request: CreateSessionRequest = await parseBody(c, CreateSessionRequestSchema);
    const info = await session.create(request);
    return c.json(info, 201);
  });

  app.get("/session/events", (c) =>
    createSseResponse(events, parseLastEventId(c.req.header("Last-Event-ID")), c.req.raw.signal, {
      heartbeatMs: options.sseHeartbeatMs,
    }),
  );

  app.get("/session/todos", (c) => {
    const body: TodosResponse = { todos: session.todos() };
    return c.json(body);
  });

  app.get("/session/messages", async (c) => {
    const body: MessagesResponse = { messages: await session.messages() };
    return c.json(body);
  });

  app.get("/session/stats", async (c) => {
    const body: SessionStats = await session.stats();
    return c.json(body);
  });

  app.get("/session/diff", async (c) => {
    const param = c.req.query("checkpoint");
    let checkpointId: number | undefined;
    if (param !== undefined) {
      const parsed = parseCheckpointId(param);
      if (parsed === null) {
        throw new InvalidRequestError("checkpoint: must be a non-negative integer");
      }
      checkpointId = parsed;
    }
    const body: DiffResponse = await session.diff(checkpointId);
    return c.json(body);
  });

  app.get("/session/checkpoints", (c) => {
    const body: CheckpointsResponse = { checkpoints: session.checkpoints() };
    return c.json(body);
  });

  // The body is optional: an empty one means { conversation: false } (files only).
  app.post("/session/checkpoints/:id/restore", limitBody, async (c) => {
    const checkpointId = parseCheckpointId(c.req.param("id"));
    if (checkpointId === null) {
      throw new InvalidRequestError("id: must be a non-negative integer");
    }
    const request: RestoreCheckpointRequest = await parseOptionalBody(
      c,
      RestoreCheckpointRequestSchema,
    );
    return c.json(
      await session.restoreCheckpoint(checkpointId, {
        conversation: request.conversation ?? false,
      }),
    );
  });

  app.post("/session/messages", limitBody, async (c) => {
    const request: PostMessageRequest = await parseBody(c, PostMessageRequestSchema);
    return c.json(await session.postMessage(request));
  });

  app.post("/session/answers/:questionId", limitBody, async (c) => {
    const answer: AnswerRequest = await parseBody(c, AnswerRequestSchema);
    await session.answer(c.req.param("questionId"), answer);
    return c.body(null, 204);
  });

  app.put("/session/model", limitBody, async (c) => {
    const request: SetModelRequest = await parseBody(c, SetModelRequestSchema);
    await session.setModel(request);
    return c.body(null, 204);
  });

  app.post("/session/abort", async (c) => {
    await session.abort();
    return c.body(null, 204);
  });

  app.delete("/session", async (c) => {
    await session.close({ force: c.req.query("force") === "true" });
    return c.body(null, 204);
  });

  app.post("/internal/questions", limitBody, async (c) => {
    const body: PublishQuestionRequest = await parseBody(c, PublishQuestionRequestSchema);
    if (!session.publishNetworkQuestion(body.question)) {
      return c.json({ error: "no_session" }, 409);
    }
    return c.json({}, 201);
  });

  app.post("/internal/questions/:id/resolved", limitBody, async (c) => {
    const body: ResolveQuestionRequest = await parseBody(c, ResolveQuestionRequestSchema);
    if (!session.resolveNetworkQuestion(c.req.param("id"), body.outcome)) {
      return c.json({ error: "question_not_found" }, 404);
    }
    return c.body(null, 204);
  });

  app.post("/internal/network", limitBody, async (c) => {
    const body: PublishNetworkEntryRequest = await parseBody(c, PublishNetworkEntryRequestSchema);
    session.publishNetworkEntry(body.entry);
    return c.body(null, 204);
  });

  if (options.webUiDir !== undefined) {
    mountWebUi(app, options.webUiDir);
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    if (err instanceof InvalidRequestError) {
      return c.json({ error: "invalid_request", message: err.message }, 400);
    }
    if (err instanceof SessionError) {
      const status = SESSION_ERROR_STATUS[err.code] ?? 500;
      return c.json({ error: err.code, message: err.message }, status);
    }
    // Never log the body or headers: they may contain secrets (AGENTS.md).
    console.error("gateway:", err instanceof Error ? err.message : "unknown error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
