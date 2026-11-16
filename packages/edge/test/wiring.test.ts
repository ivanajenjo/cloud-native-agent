import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { type ClientRequest, request as httpRequest } from "node:http";
import { type AddressInfo, createServer, isIP, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EdgeConfig, loadConfig } from "../src/config.js";
import {
  createEdgeRuntime,
  type EdgeRuntime,
  loadProviderEndpoints,
  loadServiceEndpoints,
} from "../src/wiring.js";

const TOKEN = "0123456789abcdef".repeat(4);
const GATEWAY = "http://gw.test:8090";
const VERSION = "9.9.9-test";
/** TEST-NET-1 (RFC 5737): reserved for documentation, never routed. Not an internal range for edge. */
const UNROUTABLE = "192.0.2.10";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type Cleanup = () => Promise<void>;
type FakeGateway = ReturnType<typeof fakeGateway>;

let dataDir: string;
let cleanups: Cleanup[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "edge-wiring-"));
  cleanups = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await rm(dataDir, { recursive: true, force: true });
});

/** Destroys open sockets and closes the server, so afterEach never hangs. */
function track<T extends Server | HttpServer>(server: T): T {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return server;
}

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Fake gateway: 201 for /internal/questions, 204 for everything else. Records every call. */
function fakeGateway() {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const path = new URL(url).pathname;
    return new Response(null, { status: path === "/internal/questions" ? 201 : 204 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

/** Fake resolver: IP literals resolve to themselves, names come from `records`, others to []. */
function fakeResolver(records: Record<string, string[]>) {
  return async (host: string): Promise<string[]> => {
    if (isIP(host) !== 0) return [host];
    return records[host] ?? [];
  };
}

/** Config with the given files; the ones not given point at files that do not exist. */
function configFor(paths: {
  providersFile?: string;
  notificationsFile?: string;
  webFile?: string;
}): EdgeConfig {
  return loadConfig({
    AGENT_API_TOKEN: TOKEN,
    GATEWAY_URL: GATEWAY,
    EDGE_DATA_DIR: dataDir,
    EDGE_PROVIDERS_FILE: paths.providersFile ?? missingFile("no-providers.yaml"),
    EDGE_NOTIFICATIONS_FILE: paths.notificationsFile ?? missingFile("no-notifications.yaml"),
    EDGE_WEB_FILE: paths.webFile ?? missingFile("no-web.yaml"),
  });
}

function missingFile(name: string): string {
  return join(dataDir, name);
}

function missingProvidersFile(): string {
  return missingFile("no-providers.yaml");
}

async function startRuntime(
  options: {
    providersFile?: string;
    notificationsFile?: string;
    webFile?: string;
    records?: Record<string, string[]>;
    gateway?: FakeGateway;
  } = {},
): Promise<{ runtime: EdgeRuntime; gateway: FakeGateway }> {
  const gateway = options.gateway ?? fakeGateway();
  const runtime = await createEdgeRuntime({
    config: configFor(options),
    version: VERSION,
    fetch: gateway.fetch,
    resolver: fakeResolver(options.records ?? {}),
    logError: () => undefined,
  });
  cleanups.push(async () => {
    await runtime.close();
  });
  return { runtime, gateway };
}

/** Polls `read` until it returns a value, or fails after `timeoutMs`. */
async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function questionCall(gateway: FakeGateway): RecordedCall | undefined {
  return gateway.calls.find((call) => new URL(call.url).pathname === "/internal/questions");
}

function questionIdOf(gateway: FakeGateway): string {
  const call = questionCall(gateway);
  if (call === undefined) throw new Error("no question published");
  return (call.body as { question: { id: string } }).question.id;
}

interface OpenConnect {
  req: ClientRequest;
  /** Resolves with the status the proxy answered and the tunnel socket (only on a response). */
  answered: Promise<{ status: number; socket: Socket }>;
}

/** Sends a CONNECT to the edge proxy. The client request is returned so the test can drop it. */
function openConnect(proxyPort: number, authority: string): OpenConnect {
  const req = httpRequest({
    host: "127.0.0.1",
    port: proxyPort,
    method: "CONNECT",
    path: authority,
  });
  const answered = new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    req.on("connect", (response: IncomingMessage, socket: Socket) => {
      socket.on("error", () => undefined);
      cleanups.push(async () => {
        socket.destroy();
      });
      resolve({ status: response.statusCode ?? 0, socket });
    });
    req.on("error", reject);
  });
  req.end();
  return { req, answered };
}

async function readNetworkLog(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dataDir, "network.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Network log lines, or undefined while the file does not exist yet. */
async function networkLogLines(): Promise<Array<Record<string, unknown>> | undefined> {
  try {
    return await readNetworkLog();
  } catch {
    return undefined;
  }
}

describe("loadProviderEndpoints", () => {
  it("returns no endpoints when the file does not exist", async () => {
    await expect(loadProviderEndpoints(missingProvidersFile())).resolves.toEqual([]);
  });

  it("returns the endpoint of a provider on the LAN", async () => {
    const path = join(dataDir, "providers.yaml");
    await writeFile(
      path,
      ["providers:", "  ollama:", "    baseUrl: http://192.168.1.50:11434/v1", ""].join("\n"),
    );
    await expect(loadProviderEndpoints(path)).resolves.toEqual([
      { provider: "ollama", host: "192.168.1.50", port: 11434 },
    ]);
  });

  it("rejects invalid YAML", async () => {
    const path = join(dataDir, "providers.yaml");
    await writeFile(path, "providers: [unclosed\n");
    await expect(loadProviderEndpoints(path)).rejects.toThrow(/providers\.yaml/);
  });
});

describe("loadServiceEndpoints", () => {
  const NTFY_YAML = [
    "provider: ntfy",
    "ntfy:",
    "  url: http://ntfy.lan:8081",
    "  topic: cna-alerts",
    "",
  ].join("\n");
  const SEARXNG_YAML = ["search:", "  provider: searxng", "  url: http://searxng:8080", ""].join(
    "\n",
  );

  it("returns no endpoints when both files do not exist", async () => {
    await expect(
      loadServiceEndpoints({
        notificationsFile: missingFile("no-notifications.yaml"),
        webFile: missingFile("no-web.yaml"),
      }),
    ).resolves.toEqual([]);
  });

  it("returns the ntfy and SearXNG endpoints when both files exist", async () => {
    const notificationsFile = join(dataDir, "notifications.yaml");
    const webFile = join(dataDir, "web.yaml");
    await writeFile(notificationsFile, NTFY_YAML);
    await writeFile(webFile, SEARXNG_YAML);
    await expect(loadServiceEndpoints({ notificationsFile, webFile })).resolves.toEqual([
      { service: "notifications", host: "ntfy.lan", port: 8081 },
      { service: "web_search", host: "searxng", port: 8080 },
    ]);
  });

  it("returns only the endpoint of the file that exists", async () => {
    const webFile = join(dataDir, "web.yaml");
    await writeFile(webFile, SEARXNG_YAML);
    await expect(
      loadServiceEndpoints({
        notificationsFile: missingFile("no-notifications.yaml"),
        webFile,
      }),
    ).resolves.toEqual([{ service: "web_search", host: "searxng", port: 8080 }]);
  });

  it("throws with a message that starts with notifications.yaml: for an invalid file", async () => {
    const notificationsFile = join(dataDir, "notifications.yaml");
    await writeFile(notificationsFile, "provider: [unclosed\n");
    await expect(
      loadServiceEndpoints({ notificationsFile, webFile: missingFile("no-web.yaml") }),
    ).rejects.toThrow(/^notifications\.yaml:/);
  });

  it("throws with a message that starts with web.yaml: for an invalid file", async () => {
    const webFile = join(dataDir, "web.yaml");
    await writeFile(webFile, "search:\n  provider: brave\n");
    await expect(
      loadServiceEndpoints({
        notificationsFile: missingFile("no-notifications.yaml"),
        webFile,
      }),
    ).rejects.toThrow(/^web\.yaml:/);
  });
});

describe("createEdgeRuntime startup", () => {
  it("rejects when policy.json is corrupt", async () => {
    await writeFile(join(dataDir, "policy.json"), "{not json");
    await expect(
      createEdgeRuntime({
        config: configFor({}),
        version: VERSION,
        fetch: fakeGateway().fetch,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("reports ask as the mode when there is no policy.json", async () => {
    const { runtime } = await startRuntime();
    expect(runtime.mode()).toBe("ask");
  });

  it("exposes empty providers and services when no file exists", async () => {
    const { runtime } = await startRuntime();
    expect(runtime.providers).toEqual([]);
    expect(runtime.services).toEqual([]);
  });

  it("exposes the endpoints of the provider and service files", async () => {
    const providersFile = join(dataDir, "providers.yaml");
    const notificationsFile = join(dataDir, "notifications.yaml");
    const webFile = join(dataDir, "web.yaml");
    await writeFile(
      providersFile,
      ["providers:", "  ollama:", "    baseUrl: http://192.168.1.50:11434/v1", ""].join("\n"),
    );
    await writeFile(
      notificationsFile,
      ["provider: ntfy", "ntfy:", "  url: http://ntfy.lan:8081", "  topic: cna-alerts", ""].join(
        "\n",
      ),
    );
    await writeFile(
      webFile,
      ["search:", "  provider: searxng", "  url: http://searxng:8080", ""].join("\n"),
    );

    const { runtime } = await startRuntime({ providersFile, notificationsFile, webFile });
    expect(runtime.providers).toEqual([{ provider: "ollama", host: "192.168.1.50", port: 11434 }]);
    expect(runtime.services).toEqual([
      { service: "notifications", host: "ntfy.lan", port: 8081 },
      { service: "web_search", host: "searxng", port: 8080 },
    ]);
  });

  it("refuses to start when web.yaml is invalid", async () => {
    const webFile = join(dataDir, "web.yaml");
    await writeFile(webFile, "search:\n  provider: brave\n");
    await expect(
      createEdgeRuntime({
        config: configFor({ webFile }),
        version: VERSION,
        fetch: fakeGateway().fetch,
      }),
    ).rejects.toThrow(/^web\.yaml:/);
  });
});

describe("ingress network answers", () => {
  it("answers 404 question_not_found for an unknown net-* id without calling the gateway", async () => {
    const { runtime, gateway } = await startRuntime();
    const response = await runtime.ingress.request("/session/answers/net-x", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "deny" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "question_not_found" });
    expect(gateway.calls).toEqual([]);
  });
});

describe("egress proxy with the ask flow", () => {
  it("asks through the gateway, denies on the user's answer, and logs it", async () => {
    const { runtime, gateway } = await startRuntime({
      records: { "unknown.example": ["93.184.216.34"] },
    });
    const port = await listen(track(runtime.proxy));

    const connect = openConnect(port, "unknown.example:443");
    const id = await waitFor(() => (questionCall(gateway) ? questionIdOf(gateway) : undefined));
    expect(id.startsWith("net-")).toBe(true);

    const answer = await runtime.ingress.request(`/session/answers/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "deny" }),
    });
    expect(answer.status).toBe(204);

    const connected = await connect.answered;
    expect(connected.status).toBe(403);

    const lines = await waitFor(async () => {
      const found = await networkLogLines();
      return found?.some((line) => line.reason === "user_denied") ? found : undefined;
    });
    expect(lines.some((line) => line.host === "unknown.example")).toBe(true);

    await waitFor(() =>
      gateway.calls.find(
        (call) => new URL(call.url).pathname === "/internal/network" && call.method === "POST",
      ),
    );
  });

  it("allows github.com from the base allowlist without asking", async () => {
    const { runtime, gateway } = await startRuntime({
      records: { "github.com": [UNROUTABLE] },
    });
    const port = await listen(track(runtime.proxy));

    const connect = openConnect(port, "github.com:443");
    // Give the decision time to run: an ask would publish its question right away, and a
    // denial would answer 403. The tunnel itself never completes (TEST-NET address), so
    // the client is dropped and the proxy sockets are destroyed in afterEach.
    const outcome = await Promise.race([
      connect.answered.then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    expect(outcome).toBe("pending");
    expect(questionCall(gateway)).toBeUndefined();
    connect.req.destroy();
    void connect.answered.catch(() => undefined);
  });

  it("allows a service endpoint on an internal address without asking", async () => {
    const echo = track(
      createServer((socket) => {
        socket.on("error", () => undefined);
        socket.pipe(socket);
      }),
    );
    const echoPort = await listen(echo);

    const notificationsFile = join(dataDir, "notifications.yaml");
    await writeFile(
      notificationsFile,
      [
        "provider: ntfy",
        "ntfy:",
        `  url: http://ntfy.lan:${echoPort}`,
        "  topic: cna-alerts",
        "",
      ].join("\n"),
    );

    const { runtime, gateway } = await startRuntime({
      notificationsFile,
      records: { "ntfy.lan": ["127.0.0.1"] },
    });
    const port = await listen(track(runtime.proxy));

    const connect = openConnect(port, `ntfy.lan:${echoPort}`);
    const connected = await connect.answered;
    expect(connected.status).toBe(200);
    expect(questionCall(gateway)).toBeUndefined();
    connected.socket.destroy();

    const lines = await waitFor(async () => {
      const found = await networkLogLines();
      return found?.some((line) => line.reason === "service") ? found : undefined;
    });
    expect(lines.some((line) => line.host === "ntfy.lan" && line.decision === "allow")).toBe(true);
  });

  it("allows a provider endpoint on a non-default port without asking", async () => {
    const echo = track(
      createServer((socket) => {
        socket.on("error", () => undefined);
        socket.pipe(socket);
      }),
    );
    const echoPort = await listen(echo);

    const providersFile = join(dataDir, "providers.yaml");
    await writeFile(
      providersFile,
      ["providers:", "  local:", `    baseUrl: http://127.0.0.1:${echoPort}/v1`, ""].join("\n"),
    );

    const { runtime, gateway } = await startRuntime({ providersFile });
    const port = await listen(track(runtime.proxy));

    const connect = openConnect(port, `127.0.0.1:${echoPort}`);
    const connected = await connect.answered;
    expect(connected.status).toBe(200);
    const echoed = new Promise<string>((resolve) => {
      connected.socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });
    connected.socket.write("ping");
    await expect(echoed).resolves.toBe("ping");
    expect(questionCall(gateway)).toBeUndefined();

    // The log line is written when the tunnel ends.
    connected.socket.destroy();
    const lines = await waitFor(async () => {
      const found = await networkLogLines();
      return found?.some((line) => line.reason === "provider") ? found : undefined;
    });
    expect(lines.some((line) => line.host === "127.0.0.1" && line.decision === "allow")).toBe(true);
  });

  it("denies a pending question on close and tells the gateway it was cancelled", async () => {
    const { runtime, gateway } = await startRuntime({
      records: { "unknown.example": ["93.184.216.34"] },
    });
    const port = await listen(track(runtime.proxy));

    const connect = openConnect(port, "unknown.example:443");
    const id = await waitFor(() => (questionCall(gateway) ? questionIdOf(gateway) : undefined));

    await runtime.close();

    const connected = await connect.answered;
    expect(connected.status).toBe(403);
    const resolved = await waitFor(() =>
      gateway.calls.find((call) => call.url.endsWith(`/internal/questions/${id}/resolved`)),
    );
    expect(resolved.body).toEqual({ outcome: "cancelled" });
  });
});

describe("network API wiring", () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };

  it("GET /network/log returns the connections that went through the proxy", async () => {
    const echo = track(
      createServer((socket) => {
        socket.on("error", () => undefined);
        socket.pipe(socket);
      }),
    );
    const echoPort = await listen(echo);

    const providersFile = join(dataDir, "providers.yaml");
    await writeFile(
      providersFile,
      ["providers:", "  local:", `    baseUrl: http://127.0.0.1:${echoPort}/v1`, ""].join("\n"),
    );

    const { runtime } = await startRuntime({ providersFile });
    const port = await listen(track(runtime.proxy));

    const connect = openConnect(port, `127.0.0.1:${echoPort}`);
    const connected = await connect.answered;
    expect(connected.status).toBe(200);
    connected.socket.destroy();

    const entries = await waitFor(async () => {
      const response = await runtime.ingress.request("/network/log", { headers: bearer });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { entries: Array<Record<string, unknown>> };
      return body.entries.some((entry) => entry.reason === "provider") ? body.entries : undefined;
    });
    expect(entries.some((entry) => entry.host === "127.0.0.1" && entry.decision === "allow")).toBe(
      true,
    );
  });

  it("GET /network/log without Bearer is rejected", async () => {
    const { runtime } = await startRuntime();
    const response = await runtime.ingress.request("/network/log");
    expect(response.status).toBe(401);
  });

  it("GET /network/policy lists the configured provider endpoint", async () => {
    const providersFile = join(dataDir, "providers.yaml");
    await writeFile(
      providersFile,
      ["providers:", "  ollama:", "    baseUrl: http://192.168.1.50:11434/v1", ""].join("\n"),
    );
    const { runtime } = await startRuntime({ providersFile });
    const response = await runtime.ingress.request("/network/policy", { headers: bearer });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mode).toBe("ask");
    expect(body.services).toEqual(["192.168.1.50:11434"]);
    expect(body.allowedPorts).toEqual([80, 443]);
    expect(body.base).toContain("github.com");
  });

  it("PUT /network/policy {mode:'allowlist'} changes the effective mode", async () => {
    const { runtime } = await startRuntime();
    expect(runtime.mode()).toBe("ask");
    const response = await runtime.ingress.request("/network/policy", {
      method: "PUT",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ mode: "allowlist" }),
    });
    expect(response.status).toBe(200);
    expect(runtime.mode()).toBe("allowlist");
  });
});
