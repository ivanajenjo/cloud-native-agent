import { createHash, timingSafeEqual } from "node:crypto";
import type { HealthResponse } from "@cna/shared";
import { Hono } from "hono";

export interface IngressOptions {
  /** AGENT_API_TOKEN. Validated by the caller (non-empty). */
  token: string;
  /** Base URL of the gateway, e.g. "http://agent:8090". No trailing slash needed. */
  gatewayUrl: string;
  /** edge version, reported by its own /health. */
  version: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

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

    if (
      !isPublicRequest(method, path) &&
      !isAuthorized(c.req.header("authorization"), options.token)
    ) {
      return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
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
