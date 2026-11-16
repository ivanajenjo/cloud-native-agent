import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerResult } from "../src/egress/ask.js";
import {
  createIngressApp,
  effectivePath,
  type IngressOptions,
  isAuthorized,
  isInternalPath,
  isPublicRequest,
} from "../src/ingress.js";

const TOKEN = "test-agent-token-0123456789";
const GATEWAY = "http://gw.test";
const VERSION = "9.9.9-test";

interface FetchCall {
  url: string;
  init: (RequestInit & { duplex?: "half" }) | undefined;
}

/** Fake gateway fetch that records calls and answers with `respond()`. */
function fakeGateway(respond: () => Response | Promise<Response> = () => new Response("ok")) {
  const calls: FetchCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

function setup(
  respond?: () => Response | Promise<Response>,
  extra: Partial<Pick<IngressOptions, "networkAnswers">> = {},
) {
  const gateway = fakeGateway(respond);
  const app = createIngressApp({
    token: TOKEN,
    gatewayUrl: GATEWAY,
    version: VERSION,
    fetch: gateway.fetch,
    ...extra,
  });
  return { app, calls: gateway.calls };
}

/** True when the URL the gateway would receive resolves to an internal route. */
function reachesInternal(url: string): boolean {
  const effective = effectivePath(new URL(url).pathname);
  return effective === null || effective.toLowerCase().startsWith("/internal");
}

const auth = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public routes answered without token", () => {
  it("GET /health is answered by edge with its own version", async () => {
    const { app, calls } = setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "edge", version: VERSION });
    expect(calls).toHaveLength(0);
  });

  it("HEAD /health is answered by edge without calling the gateway", async () => {
    const { app, calls } = setup();
    const res = await app.request("/health", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("POST /health without token is rejected and the gateway is not called", async () => {
    const { app, calls } = setup();
    const res = await app.request("/health", { method: "POST" });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("GET / , GET /ui and GET /ui/app.js are forwarded without token", async () => {
    const { app, calls } = setup();
    for (const path of ["/", "/ui", "/ui/app.js"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
    }
    expect(calls.map((call) => call.url)).toEqual([
      `${GATEWAY}/`,
      `${GATEWAY}/ui`,
      `${GATEWAY}/ui/app.js`,
    ]);
  });

  it("GET /uix and GET /health/x without token are rejected", async () => {
    const { app, calls } = setup();
    expect((await app.request("/uix")).status).toBe(401);
    expect((await app.request("/health/x")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("does not forward /ui/../session without token", async () => {
    const { app, calls } = setup();
    const res = await app.request("/ui/../session");
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("authorization", () => {
  it("GET /session without header gets 401 with WWW-Authenticate and no gateway call", async () => {
    const { app, calls } = setup();
    const res = await app.request("/session");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["wrong token", `Bearer ${TOKEN.slice(1)}`],
    ["token with one extra character", `Bearer ${TOKEN}x`],
    ["Basic scheme", `Basic ${TOKEN}`],
    ["two spaces", `Bearer  ${TOKEN}`],
    ["Bearer without token", "Bearer"],
  ])("rejects %s", async (_name, authorization) => {
    const { app, calls } = setup();
    const res = await app.request("/session", { headers: { authorization } });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("accepts a lowercase bearer scheme", async () => {
    const { app, calls } = setup();
    const res = await app.request("/session", {
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("forwarding", () => {
  it("forwards method, path, query, body and filtered headers", async () => {
    const { app, calls } = setup();
    const body = JSON.stringify({ repo: "owner/name", prompt: "hola" });
    const res = await app.request("/session?x=1", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        host: "edge.local",
        connection: "x-secret-hop",
        "x-secret-hop": "1",
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${GATEWAY}/session?x=1`);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.duplex).toBe("half");
    expect(await new Response(call?.init?.body).text()).toBe(body);

    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("x-secret-hop")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-forwarded-proto")).toBe("http");
  });

  it("returns the gateway status and body without hop-by-hop headers", async () => {
    const { app } = setup(
      () =>
        new Response("conflict", {
          status: 409,
          headers: {
            "transfer-encoding": "chunked",
            connection: "close",
            "x-gateway": "1",
          },
        }),
    );
    const res = await app.request("/session", { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("conflict");
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("x-gateway")).toBe("1");
  });

  it("streams the gateway body: the first chunk arrives while the stream stays open", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
      },
    });
    const { app } = setup(
      () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );

    const res = await app.request("/session/events", { headers: auth });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("data: first\n\n");
    expect(first?.done).toBe(false);

    await reader?.cancel();
  });

  it("returns 502 bad_gateway and logs without request headers when fetch throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = setup(() => {
      throw new TypeError("fetch failed");
    });

    const res = await app.request("/session", { headers: auth });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "bad_gateway" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
  });
});

describe("isAuthorized", () => {
  it.each([
    ["Bearer token", `Bearer ${TOKEN}`, true],
    ["lowercase scheme", `bearer ${TOKEN}`, true],
    ["uppercase scheme", `BEARER ${TOKEN}`, true],
    ["undefined header", undefined, false],
    ["empty header", "", false],
    ["Basic scheme", `Basic ${TOKEN}`, false],
    ["bare token", TOKEN, false],
    ["two spaces", `Bearer  ${TOKEN}`, false],
    ["no space", `Bearer${TOKEN}`, false],
    ["Bearer alone", "Bearer", false],
    ["Bearer with empty token", "Bearer ", false],
    ["wrong token", `Bearer ${TOKEN}-x`, false],
    ["prefix of token", `Bearer ${TOKEN.slice(0, -1)}`, false],
    ["trailing space", `Bearer ${TOKEN} `, false],
  ])("%s -> %s", (_name, header, expected) => {
    expect(isAuthorized(header, TOKEN)).toBe(expected);
  });

  it("never authorizes when the configured token is empty", () => {
    expect(isAuthorized("Bearer ", "")).toBe(false);
    expect(isAuthorized("Bearer x", "")).toBe(false);
  });
});

describe("isPublicRequest", () => {
  it.each([
    ["GET", "/health", true],
    ["HEAD", "/health", true],
    ["POST", "/health", false],
    ["GET", "/", true],
    ["GET", "/ui", true],
    ["HEAD", "/ui/app.js", true],
    ["GET", "/ui/assets/index.js", true],
    ["POST", "/", false],
    ["POST", "/ui/app.js", false],
    ["GET", "/uix", false],
    ["GET", "/health/x", false],
    ["GET", "/session", false],
    ["GET", "/Health", false],
    ["get", "/health", false],
    ["GET", "/ui/../session", false],
    ["GET", "/ui/%2e%2e/session", false],
    ["GET", "/ui/%2E%2E/session", false],
    ["GET", "/ui/./app.js", false],
    ["GET", "/ui/a\\..\\session", false],
    ["GET", "/ui/..", false],
    ["GET", "/%2e%2e/ui/", false],
  ])("%s %s -> %s", (method, path, expected) => {
    expect(isPublicRequest(method, path)).toBe(expected);
  });
});

describe("internal routes are never forwarded (ADR-0008)", () => {
  it.each([
    "/internal/questions",
    "/internal",
    "/INTERNAL/network",
    "/session/../internal/questions",
    "/session/%2e%2e/internal/questions",
    "/%69nternal/questions",
    "/internal%2fquestions",
    "/session/%E0%A4%A",
  ])("POST %s is answered 404 with and without token, gateway not called", async (path) => {
    const { app, calls } = setup();
    const withoutToken = await app.request(path, { method: "POST", body: "{}" });
    expect(withoutToken.status).toBe(404);
    expect(await withoutToken.json()).toEqual({ error: "not_found" });

    const withToken = await app.request(path, { method: "POST", headers: auth, body: "{}" });
    expect(withToken.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("a traversal that the gateway would resolve to /internal is not forwarded", async () => {
    const { app, calls } = setup();
    const res = await app.request("/session/..%2finternal", { headers: auth });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(reachesInternal(calls[0]?.url ?? "")).toBe(false);
  });

  it("forwards /internalx and /session/internal with token", async () => {
    const { app, calls } = setup();
    expect((await app.request("/internalx", { headers: auth })).status).toBe(200);
    expect((await app.request("/session/internal", { headers: auth })).status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      `${GATEWAY}/internalx`,
      `${GATEWAY}/session/internal`,
    ]);
  });
});

describe("network answers (ADR-0008)", () => {
  const postAnswer = (
    app: ReturnType<typeof setup>["app"],
    path: string,
    body: unknown,
    headers: Record<string, string> = auth,
  ) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("POST /session/answers/net-abc with {value} and token answers locally with 204", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", { value: "allow_once" });
    expect(res.status).toBe(204);
    expect(answer).toHaveBeenCalledWith("net-abc", "allow_once");
    expect(calls).toHaveLength(0);
  });

  it("without token gets 401 and answer is not called", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", { value: "allow_once" }, {});
    expect(res.status).toBe(401);
    expect(answer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("{cancelled:true} answers deny", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", { cancelled: true });
    expect(res.status).toBe(204);
    expect(answer).toHaveBeenCalledWith("net-abc", "deny");
  });

  it("{confirmed:true} is rejected with 400 and answer is not called", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", { confirmed: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(answer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("broken JSON is rejected with 400", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", '{"value":');
    expect(res.status).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it("a body over 64 KiB gets 413", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", { value: "a".repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "invalid_request", message: "body too large" });
    expect(answer).not.toHaveBeenCalled();
  });

  it("a body of exactly 64 KiB is accepted", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app } = setup(undefined, { networkAnswers: { answer } });
    const body = JSON.stringify({ value: "a".repeat(64 * 1024 - 12) });
    expect(new TextEncoder().encode(body).byteLength).toBe(64 * 1024);
    const res = await postAnswer(app, "/session/answers/net-abc", body);
    expect(res.status).toBe(204);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not_found", 404, "question_not_found"],
    ["already_resolved", 409, "question_resolved"],
    ["invalid_value", 400, "invalid_request"],
  ] as const)("maps %s to %i %s", async (result, status, error) => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => result);
    const { app } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc", { value: "deny" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: error });
  });

  it("without networkAnswers a net- answer gets 404 question_not_found and is not forwarded", async () => {
    const { app, calls } = setup();
    const res = await postAnswer(app, "/session/answers/net-abc", { value: "deny" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "question_not_found" });
    expect(calls).toHaveLength(0);
  });

  it("answers without the net- prefix are forwarded to the gateway", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/q-1", { value: "x" });
    expect(res.status).toBe(200);
    expect(answer).not.toHaveBeenCalled();
    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/session/answers/q-1`]);
  });

  it("a path with an extra segment is forwarded to the gateway", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-a/extra", { value: "deny" });
    expect(res.status).toBe(200);
    expect(answer).not.toHaveBeenCalled();
    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/session/answers/net-a/extra`]);
  });

  it("a trailing slash is still answered locally", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net-abc/", { value: "deny" });
    expect(res.status).toBe(204);
    expect(answer).toHaveBeenCalledWith("net-abc", "deny");
    expect(calls).toHaveLength(0);
  });

  it("an encoded hyphen is decoded and answered locally", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await postAnswer(app, "/session/answers/net%2Dabc", { value: "deny" });
    expect(res.status).toBe(204);
    expect(answer).toHaveBeenCalledWith("net-abc", "deny");
    expect(calls).toHaveLength(0);
  });

  it("only POST is answered locally: GET on a net- answer is forwarded", async () => {
    const answer = vi.fn((_id: string, _value: string): AnswerResult => "ok");
    const { app, calls } = setup(undefined, { networkAnswers: { answer } });
    const res = await app.request("/session/answers/net-abc", { headers: auth });
    expect(res.status).toBe(200);
    expect(answer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe("effectivePath", () => {
  it.each([
    ["/a/b", "/a/b"],
    ["/session/../internal", "/internal"],
    ["/session/%2e%2e/internal", "/internal"],
    ["/%69nternal/questions", "/internal/questions"],
    ["/internal%2fquestions", "/internal/questions"],
    ["/session/..%2finternal", "/session/../internal"],
    ["/a%20b", "/a b"],
    ["/%E0%A4%A", null],
    ["//internal/questions", "/internal/questions"],
    ["/session//answers", "/session/answers"],
  ])("%s -> %s", (path, expected) => {
    expect(effectivePath(path)).toBe(expected);
  });
});

describe("isInternalPath", () => {
  it.each([
    ["/internal", true],
    ["/internal/questions", true],
    ["/INTERNAL/network", true],
    ["/session/../internal/questions", true],
    ["/%69nternal/questions", true],
    ["/internal%2fquestions", true],
    ["/%E0%A4%A", true],
    ["/internalx", false],
    ["/session/internal", false],
    ["/session", false],
    ["/session/..%2finternal", false],
  ])("%s -> %s", (path, expected) => {
    expect(isInternalPath(path)).toBe(expected);
  });
});
