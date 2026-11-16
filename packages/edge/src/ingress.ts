import { createHash, timingSafeEqual } from "node:crypto";
import {
  AnswerRequestSchema,
  type ApiError,
  type HealthResponse,
  INTERNAL_PATH_PREFIX,
  NETWORK_QUESTION_ID_PREFIX,
} from "@cna/shared";
import { type Context, Hono } from "hono";
import type { AnswerResult } from "./egress/ask.js";

export interface IngressOptions {
  /** AGENT_API_TOKEN. Validated by the caller (non-empty). */
  token: string;
  /** Base URL of the gateway, e.g. "http://agent:8090". No trailing slash needed. */
  gatewayUrl: string;
  /** edge version, reported by its own /health. */
  version: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Answers network questions (ids "net-*") locally. Normally AskCoordinator. */
  networkAnswers?: { answer(id: string, value: string): AnswerResult };
  /** Answers `/network/*` (network policy and log). Never forwarded to the gateway. */
  networkApi?: Hono;
}

/** Largest accepted body of `POST /session/answers/:id`. */
const MAX_ANSWER_BODY_BYTES = 64 * 1024;

/** Internal routes of the gateway (ADR-0008). Never forwarded from the public entry. */
const INTERNAL_ROOT = INTERNAL_PATH_PREFIX.slice(0, -1);

const ANSWER_ROUTE = /^\/session\/answers\/([^/]+)\/?$/;

/** Hop-by-hop headers (RFC 9110 section 7.6.1), dropped in both directions. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request-only headers that must never reach the gateway. */
const REQUEST_ONLY_DROPPED_HEADERS: ReadonlySet<string> = new Set(["authorization", "host"]);

const BEARER_PREFIX = /^bearer /i;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * True for the requests that skip the Bearer check: `GET`/`HEAD` on `/`, `/ui`, `/ui/...`
 * and `/health` (which edge answers itself). The path is compared as sent, without
 * normalization. Paths with dot segments under `/ui/` are not public: the HTTP client
 * would resolve them before they reach the gateway, so `/ui/../session` would bypass the token.
 */
export function isPublicRequest(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  if (path === "/health" || path === "/" || path === "/ui") {
    return true;
  }
  return path.startsWith("/ui/") && !hasDotSegment(path);
}

/** True when a path segment is `.` or `..`, also when percent-encoded or split by backslash. */
function hasDotSegment(path: string): boolean {
  return path.split(/[/\\]/).some((segment) => {
    const normalized = segment.replace(/[\t\n\r]/g, "").replace(/%2e/gi, ".");
    return normalized === "." || normalized === "..";
  });
}

/** Checks `Authorization: Bearer <token>` (scheme case-insensitive, one space) in constant time. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !BEARER_PREFIX.test(header)) {
    return false;
  }
  const presented = header.slice("Bearer ".length);
  if (presented.length === 0 || token.length === 0) {
    return false;
  }
  // Hashing both values gives equal-length buffers, so the comparison does not leak length.
  return timingSafeEqual(sha256(presented), sha256(token));
}

/** Raw request target ("/path?query") as the client sent it, without URL normalization. */
function requestTarget(url: string): string {
  const schemeEnd = url.indexOf("://");
  const start = url.indexOf("/", schemeEnd + 3);
  return start === -1 ? "/" : url.slice(start);
}

function pathOf(target: string): string {
  const queryStart = target.indexOf("?");
  return queryStart === -1 ? target : target.slice(0, queryStart);
}

/**
 * The path the gateway would actually see: resolves dot segments ("." "..", also %2e) like the
 * WHATWG URL parser does (`new URL(path, "http://edge").pathname`), then percent-decodes it
 * (decodeURIComponent; if that throws, return null). Used only to classify the request.
 */
export function effectivePath(path: string): string | null {
  let pathname: string;
  try {
    // Appended, not resolved: "//internal/x" relative to a base would turn "internal" into a host.
    // Empty segments are collapsed so "//internal/x" counts as "/internal/x" (fail closed).
    pathname = new URL(`http://edge${path.startsWith("/") ? "" : "/"}${path}`).pathname.replace(
      /\/{2,}/g,
      "/",
    );
  } catch {
    return null;
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * True if the request targets an internal route: effectivePath is null, or (lowercased) equals
 * "/internal" or starts with "/internal/". Unclassifiable paths count as internal (fail closed).
 */
export function isInternalPath(path: string): boolean {
  const effective = effectivePath(path);
  if (effective === null) {
    return true;
  }
  const lower = effective.toLowerCase();
  return lower === INTERNAL_ROOT || lower.startsWith(INTERNAL_PATH_PREFIX);
}

function apiError(
  c: Context,
  status: 400 | 404 | 405 | 409 | 413,
  error: ApiError["error"],
  message?: string,
): Response {
  const body: ApiError = message === undefined ? { error } : { error, message };
  return c.json(body, status);
}

/** True for `/network` and every path under `/network/` (compared lowercased). */
function isNetworkPath(effective: string): boolean {
  const lower = effective.toLowerCase();
  return lower === "/network" || lower.startsWith("/network/");
}

/**
 * Hands a `/network/*` request to the network API, with the effective path (dot segments and
 * percent-encoding resolved) and the original query. Never reaches the gateway (ADR-0006).
 */
function answerNetworkApi(
  c: Context,
  networkApi: Hono | undefined,
  effective: string,
  target: string,
): Promise<Response> | Response {
  if (networkApi === undefined) {
    return apiError(c, 404, "not_found");
  }
  const url = new URL("http://edge/");
  url.pathname = effective;
  const queryStart = target.indexOf("?");
  if (queryStart !== -1) {
    url.search = target.slice(queryStart);
  }

  const request = c.req.raw;
  // Only the content type is passed on: the network API must not see the Bearer token.
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }
  const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
  const init: ProxyRequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: "half" as const } : {}),
  };
  return networkApi.fetch(new Request(url, init));
}

/**
 * Reads the body as UTF-8 text, stopping as soon as it exceeds `limit` bytes.
 * Returns null when the limit is exceeded.
 */
export async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Answers `POST /session/answers/net-*` locally (ADR-0008 §3). The body is validated like any
 * answer: `{value}` is an answer, `{cancelled:true}` denies, `{confirmed}` is not valid here.
 */
async function answerNetworkQuestion(
  c: Context,
  networkAnswers: IngressOptions["networkAnswers"],
  questionId: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  if (networkAnswers === undefined) {
    return apiError(c, 404, "question_not_found");
  }

  const text = await readLimitedText(body, MAX_ANSWER_BODY_BYTES);
  if (text === null) {
    return apiError(c, 413, "invalid_request", "body too large");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return apiError(c, 400, "invalid_request");
  }
  const parsed = AnswerRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(c, 400, "invalid_request");
  }

  const answer = parsed.data;
  let result: AnswerResult;
  if ("value" in answer) {
    result = networkAnswers.answer(questionId, answer.value);
  } else if ("cancelled" in answer) {
    result = networkAnswers.answer(questionId, "deny");
  } else {
    return apiError(c, 400, "invalid_request");
  }

  switch (result) {
    case "ok":
      return c.body(null, 204);
    case "not_found":
      return apiError(c, 404, "question_not_found");
    case "already_resolved":
      return apiError(c, 409, "question_resolved");
    case "invalid_value":
      return apiError(c, 400, "invalid_request");
  }
}

/** Copies headers, skipping hop-by-hop ones, the extra names given, and those listed in `Connection`. */
function copyHeaders(source: Headers, extraDropped: ReadonlySet<string>): Headers {
  const connectionListed = (source.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const result = new Headers();
  source.forEach((value, name) => {
    if (HOP_BY_HOP_HEADERS.has(name) || extraDropped.has(name) || connectionListed.includes(name)) {
      return;
    }
    result.append(name, value);
  });
  return result;
}

const NO_EXTRA_DROPPED: ReadonlySet<string> = new Set();

type ProxyRequestInit = RequestInit & { duplex?: "half" };

export function createIngressApp(options: IngressOptions): Hono {
  const fetchGateway = options.fetch ?? globalThis.fetch;
  const gatewayBase = options.gatewayUrl.replace(/\/+$/, "");
  const app = new Hono();

  app.all("*", async (c) => {
    const request = c.req.raw;
    const method = request.method;
    const target = requestTarget(c.req.url);
    const path = pathOf(target);

    if (path === "/health" && (method === "GET" || method === "HEAD")) {
      const body: HealthResponse = { status: "ok", service: "edge", version: options.version };
      return c.json(body);
    }

    // Internal routes are never forwarded, with or without a token (ADR-0008).
    if (isInternalPath(path)) {
      return apiError(c, 404, "not_found");
    }

    if (
      !isPublicRequest(method, path) &&
      !isAuthorized(c.req.header("authorization"), options.token)
    ) {
      return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }

    // Network policy and log are answered by edge, with the Bearer token already checked.
    const effective = effectivePath(path);
    if (effective !== null && isNetworkPath(effective)) {
      return answerNetworkApi(c, options.networkApi, effective, target);
    }

    // Network answers are decided by edge and never reach the gateway (ADR-0006, ADR-0008).
    const answerId = ANSWER_ROUTE.exec(path)?.[1];
    if (method === "POST" && answerId !== undefined) {
      let questionId: string;
      try {
        questionId = decodeURIComponent(answerId);
      } catch {
        return apiError(c, 400, "invalid_request");
      }
      if (questionId.startsWith(NETWORK_QUESTION_ID_PREFIX)) {
        return answerNetworkQuestion(c, options.networkAnswers, questionId, request.body);
      }
    }

    const headers = copyHeaders(request.headers, REQUEST_ONLY_DROPPED_HEADERS);
    headers.set("x-forwarded-proto", c.req.url.slice(0, c.req.url.indexOf(":")));

    // The body is streamed, not read. GET and HEAD cannot carry one in fetch.
    const hasBody = request.body !== null && method !== "GET" && method !== "HEAD";
    const init: ProxyRequestInit = {
      method,
      headers,
      signal: request.signal,
      ...(hasBody ? { body: request.body, duplex: "half" as const } : {}),
    };

    let upstream: Response;
    try {
      upstream = await fetchGateway(`${gatewayBase}${target}`, init);
    } catch (error) {
      // Log only the error message: never request headers, which carry the token.
      console.error(
        "edge: gateway request failed:",
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: "bad_gateway" }, 502);
    }

    // Pass the body through as a stream: /session/events is SSE and never ends by itself.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyHeaders(upstream.headers, NO_EXTRA_DROPPED),
    });
  });

  return app;
}
