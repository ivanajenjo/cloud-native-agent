import { afterEach, describe, expect, it, vi } from "vitest";
import { createIngressApp, isAuthorized, isPublicRequest } from "../src/ingress.js";

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

function setup(respond?: () => Response | Promise<Response>) {
  const gateway = fakeGateway(respond);
  const app = createIngressApp({
    token: TOKEN,
    gatewayUrl: GATEWAY,
    version: VERSION,
    fetch: gateway.fetch,
  });
  return { app, calls: gateway.calls };
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
