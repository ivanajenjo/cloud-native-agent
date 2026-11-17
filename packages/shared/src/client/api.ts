/**
 * REST + SSE client of the gateway/edge API. Browser and Node compatible: only web standard
 * APIs, and only type imports from the rest of `@cna/shared`.
 */
import type { StreamEvent } from "../events.js";
import type { HistoryEntry, HistoryResponse, ResumeSessionRequest } from "../history.js";
import type { NetworkLogEntry } from "../network.js";
import type {
  NetworkLogResponse,
  NetworkPolicyResponse,
  UpdateNetworkPolicyRequest,
} from "../network-api.js";
import type {
  AnswerRequest,
  ApiErrorCode,
  CreateSessionRequest,
  MessagesResponse,
  ModelsResponse,
  PiMessage,
  PostMessageRequest,
  PostMessageResponse,
  SessionInfo,
  SessionStats,
  SetModelRequest,
} from "../session.js";
import type { TodoItem, TodosResponse } from "../todo.js";
import type {
  Checkpoint,
  CheckpointsResponse,
  DiffResponse,
  RestoreCheckpointRequest,
  RestoreCheckpointResponse,
} from "../workspace.js";
import { SseParser, type SseRecord } from "./sse.js";

export interface ApiClientOptions {
  /** e.g. "http://127.0.0.1:8080", or "" for same-origin relative URLs (browser). Trailing slashes are removed. */
  baseUrl: string;
  /** AGENT_API_TOKEN; sent as `Authorization: Bearer <token>` when non-empty. */
  token?: string;
  /** Default: globalThis.fetch (call it unbound-safe: `(input, init) => globalThis.fetch(input, init)`). */
  fetch?: typeof globalThis.fetch;
}

/** Non-2xx answer, or a network failure (status 0, code "network_error"). */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | "network_error" | "unknown";

  constructor(status: number, code: ApiErrorCode | "network_error" | "unknown", message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export type EventStreamItem =
  | { kind: "event"; event: StreamEvent }
  /** `: truncated` comment from the gateway: the replay missed events; reload GET /session/messages. */
  | { kind: "truncated" }
  /** The ids went backwards after a reconnect (new gateway process): drop all derived state. */
  | { kind: "reset" };

interface RequestOptions {
  body?: unknown;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Marker returned by {@link raceAbort} when the signal aborted first. */
const ABORTED: unique symbol = Symbol("aborted");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves with the promise value, or with ABORTED as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Waits `ms`, or less if `signal` aborts. Never rejects. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Turns a non-2xx answer into an ApiClientError. The token is never included. */
async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let code: ApiClientError["code"] = "unknown";
  let message = `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      if (typeof body.error === "string") code = body.error as ApiErrorCode;
      if (typeof body.message === "string") message = body.message;
    }
  } catch {
    // Not a JSON body: keep the defaults.
  }
  throw new ApiClientError(response.status, code, message);
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Maps an SSE record to a stream item; undefined when the record is skipped. */
function toStreamItem(record: SseRecord): EventStreamItem | undefined {
  if (record.kind === "comment") {
    return record.text === "truncated" ? { kind: "truncated" } : undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.data);
  } catch {
    return undefined;
  }
  if (
    isRecord(parsed) &&
    typeof parsed.id === "number" &&
    isRecord(parsed.event) &&
    typeof parsed.event.type === "string"
  ) {
    return { kind: "event", event: parsed as unknown as StreamEvent };
  }
  return undefined;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token ? options.token : undefined;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** GET /session; 404 → null. */
  async getSession(): Promise<SessionInfo | null> {
    const response = await this.send("GET", "/session");
    if (response.status === 404) return null;
    await assertOk(response);
    return readJson<SessionInfo>(response);
  }

  /** POST /session (201). */
  async createSession(body: CreateSessionRequest): Promise<SessionInfo> {
    const response = await this.send("POST", "/session", { body });
    await assertOk(response);
    return readJson<SessionInfo>(response);
  }

  /** GET /session/messages → `.messages`. */
  async messages(): Promise<PiMessage[]> {
    const response = await this.send("GET", "/session/messages");
    await assertOk(response);
    return (await readJson<MessagesResponse>(response)).messages;
  }

  /** POST /session/messages. */
  async postMessage(body: PostMessageRequest): Promise<PostMessageResponse> {
    const response = await this.send("POST", "/session/messages", { body });
    await assertOk(response);
    return readJson<PostMessageResponse>(response);
  }

  /** POST /session/answers/:id (204). */
  async answer(questionId: string, body: AnswerRequest): Promise<void> {
    const path = `/session/answers/${encodeURIComponent(questionId)}`;
    const response = await this.send("POST", path, { body });
    await assertOk(response);
  }

  /** PUT /session/model (204). */
  async setModel(body: SetModelRequest): Promise<void> {
    const response = await this.send("PUT", "/session/model", { body });
    await assertOk(response);
  }

  /** POST /session/abort (204). */
  async abort(): Promise<void> {
    const response = await this.send("POST", "/session/abort");
    await assertOk(response);
  }

  /** GET /session/todos → `.todos`. */
  async todos(): Promise<TodoItem[]> {
    const response = await this.send("GET", "/session/todos");
    await assertOk(response);
    return (await readJson<TodosResponse>(response)).todos;
  }

  /** GET /session/diff[?checkpoint=N]. */
  async diff(checkpoint?: number): Promise<DiffResponse> {
    const query = new URLSearchParams();
    if (checkpoint !== undefined) query.set("checkpoint", String(checkpoint));
    const response = await this.send("GET", "/session/diff", { query });
    await assertOk(response);
    return readJson<DiffResponse>(response);
  }

  /** GET /session/checkpoints → `.checkpoints`. */
  async checkpoints(): Promise<Checkpoint[]> {
    const response = await this.send("GET", "/session/checkpoints");
    await assertOk(response);
    return (await readJson<CheckpointsResponse>(response)).checkpoints;
  }

  /** POST /session/checkpoints/:id/restore. The body is `{}` when not given. */
  async restoreCheckpoint(
    id: number,
    body: RestoreCheckpointRequest = {},
  ): Promise<RestoreCheckpointResponse> {
    const response = await this.send("POST", `/session/checkpoints/${id}/restore`, { body });
    await assertOk(response);
    return readJson<RestoreCheckpointResponse>(response);
  }

  /** DELETE /session[?force=true] (204). */
  async closeSession(options: { force?: boolean } = {}): Promise<void> {
    const query = new URLSearchParams();
    if (options.force) query.set("force", "true");
    const response = await this.send("DELETE", "/session", { query });
    await assertOk(response);
  }

  /** GET /session/stats. */
  async stats(): Promise<SessionStats> {
    const response = await this.send("GET", "/session/stats");
    await assertOk(response);
    return readJson<SessionStats>(response);
  }

  /** GET /session/history → `.sessions` (newest first). */
  async history(): Promise<HistoryEntry[]> {
    const response = await this.send("GET", "/session/history");
    await assertOk(response);
    return (await readJson<HistoryResponse>(response)).sessions;
  }

  /** POST /session/history/:id/resume (201). The body is `{}` when not given. */
  async resumeSession(id: string, body: ResumeSessionRequest = {}): Promise<SessionInfo> {
    const path = `/session/history/${encodeURIComponent(id)}/resume`;
    const response = await this.send("POST", path, { body });
    await assertOk(response);
    return readJson<SessionInfo>(response);
  }

  /** GET /models. */
  async models(): Promise<ModelsResponse> {
    const response = await this.send("GET", "/models");
    await assertOk(response);
    return readJson<ModelsResponse>(response);
  }

  /** GET /network/log[?limit=N] → `.entries`. */
  async networkLog(limit?: number): Promise<NetworkLogEntry[]> {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    const response = await this.send("GET", "/network/log", { query });
    await assertOk(response);
    return (await readJson<NetworkLogResponse>(response)).entries;
  }

  /** GET /network/policy. */
  async networkPolicy(): Promise<NetworkPolicyResponse> {
    const response = await this.send("GET", "/network/policy");
    await assertOk(response);
    return readJson<NetworkPolicyResponse>(response);
  }

  /** PUT /network/policy. */
  async updateNetworkPolicy(body: UpdateNetworkPolicyRequest): Promise<NetworkPolicyResponse> {
    const response = await this.send("PUT", "/network/policy", { body });
    await assertOk(response);
    return readJson<NetworkPolicyResponse>(response);
  }

  /**
   * One SSE connection to GET /session/events (header `Accept: text/event-stream`, and
   * `Last-Event-ID: <n>` when lastEventId > 0). Yields `event` items (data JSON-parsed as StreamEvent;
   * records whose data is not JSON or is not an object with a numeric `id` and an `event.type` string are skipped)
   * and `truncated` for the comment "truncated". Other comments are ignored. Ends when the server ends the stream.
   * Non-2xx → throws ApiClientError before yielding. Abort of `signal` ends the iteration silently (no throw).
   * Decodes with TextDecoder("utf-8") in streaming mode (`{ stream: true }`).
   */
  async *events(
    options: { lastEventId?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<EventStreamItem> {
    const { lastEventId = 0, signal } = options;
    if (signal?.aborted) return;

    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastEventId > 0) headers["last-event-id"] = String(lastEventId);

    let response: Response | typeof ABORTED;
    try {
      response = await raceAbort(this.send("GET", "/session/events", { headers, signal }), signal);
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
    if (response === ABORTED) return;
    await assertOk(response);

    const body = response.body;
    if (body === null) return;
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parser = new SseParser();
    try {
      while (!signal?.aborted) {
        const next = await raceAbort(reader.read(), signal);
        if (next === ABORTED) return;
        if (next.done) break;
        for (const record of parser.push(decoder.decode(next.value, { stream: true }))) {
          const item = toStreamItem(record);
          if (item !== undefined) yield item;
        }
      }
      if (!signal?.aborted) {
        for (const record of parser.push(decoder.decode())) {
          const item = toStreamItem(record);
          if (item !== undefined) yield item;
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const query = options.query?.toString() ?? "";
    const url = `${this.baseUrl}${path}${query === "" ? "" : `?${query}`}`;
    try {
      return await this.fetchImpl(url, { method, headers, body, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiClientError(0, "network_error", errorMessage(error));
    }
  }
}

export interface FollowEventsOptions {
  signal?: AbortSignal;
  /** Start after this id. Default 0 (full replay). */
  lastEventId?: number;
  /** Wait before reconnecting. Default 1000 ms. */
  retryDelayMs?: number;
  /** Called on each disconnection (stream end or error other than 401), before waiting. */
  onDisconnect?: (error: unknown) => void;
}

/**
 * Follows the event stream forever: reconnects after `retryDelayMs` with `Last-Event-ID` = last id seen.
 * After a reconnect, if the first event's id is <= the last id seen, yields `{kind:"reset"}` before it.
 * Stops (returns) when `signal` aborts. An ApiClientError with status 401 is rethrown (no retry).
 */
export async function* followEvents(
  client: ApiClient,
  options: FollowEventsOptions = {},
): AsyncGenerator<EventStreamItem> {
  const { signal, retryDelayMs = 1000, onDisconnect } = options;
  let lastId = options.lastEventId ?? 0;
  let reconnected = false;

  while (!signal?.aborted) {
    let checkReset = reconnected;
    let disconnectReason: unknown;
    try {
      for await (const item of client.events({ lastEventId: lastId, signal })) {
        if (item.kind !== "event") {
          yield item;
          continue;
        }
        const id = item.event.id;
        if (checkReset) {
          checkReset = false;
          if (id <= lastId) yield { kind: "reset" };
        }
        lastId = id;
        yield item;
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiClientError && error.status === 401) throw error;
      disconnectReason = error;
    }
    if (signal?.aborted) return;
    onDisconnect?.(disconnectReason);
    await sleep(retryDelayMs, signal);
    reconnected = true;
  }
}
