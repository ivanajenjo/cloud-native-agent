import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import {
  type AddressInfo,
  createServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ApiError,
  NetworkLogEntry,
  Question,
  SessionEvent,
  SessionInfo,
  StreamEvent,
} from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeConfig } from "../../packages/edge/src/config.js";
import { createEdgeRuntime, type EdgeRuntime } from "../../packages/edge/src/wiring.js";
import { type GatewayConfig, loadGatewayConfig } from "../../packages/gateway/src/config.js";
import type { PiLaunchSpec } from "../../packages/gateway/src/pi/launch.js";
import type { RpcBridgeHandlers, RpcCommandInput } from "../../packages/gateway/src/rpc/bridge.js";
import type { PiProcess } from "../../packages/gateway/src/session/manager.js";
import { createGatewayRuntime, type GatewayRuntime } from "../../packages/gateway/src/wiring.js";
import { createGitRunner } from "../../packages/gateway/src/workspace/git.js";

/** Only edge holds this token (AGENTS.md invariant). */
const TOKEN = "0123456789abcdef".repeat(4);
const GATEWAY_URL = "http://agent:8090";
const VERSION = "0.0.0-test";
/** TEST-NET-3 (RFC 5737): documentation address, never routed. Every test name resolves to it. */
const PUBLIC_IP = "203.0.113.10";
const ASK_TIMEOUT_MS = 2000;
const SHORT_ASK_TIMEOUT_MS = 300;
const SESSION_BODY = { repo: "octo/hello", prompt: "hola" };

const PROVIDERS_YAML = `default: ollama/qwen3-coder:30b
providers:
  ollama:
    baseUrl: http://192.168.1.50:11434/v1
    api: openai-completions
    models:
      - id: qwen3-coder:30b
        contextWindow: 65536
`;

/** Isolated from the machine's git config. */
const GIT_ENV: Record<string, string | undefined> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const realGit = createGitRunner(GIT_ENV);

/** One request that edge forwarded to the gateway app, as the gateway saw it. */
interface GatewayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Status the gateway answered with. */
  status: number;
}

interface Stack {
  edge: EdgeRuntime;
  /** Every request edge sent to the gateway through the injected fetch. */
  gatewayRequests: GatewayRequest[];
  /** Addresses the upstream connection was opened to, in order. */
  upstreamHosts: string[];
  /** Names the resolver was asked about, in order. */
  resolved: string[];
  proxyPort: number;
  dataDir: string;
}

let root: string;
let remoteBase: string;
let cleanups: Array<() => Promise<void> | void>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-integration-"));
  cleanups = [];

  // Source repo with one commit on main, then a bare clone as the "remote" octo/hello.
  const source = join(root, "source");
  await mkdir(source);
  await realGit(["init", "--initial-branch=main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await realGit(["add", "README.md"], { cwd: source });
  await realGit(["commit", "-m", "initial"], { cwd: source });
  await mkdir(join(root, "remote", "octo"), { recursive: true });
  await realGit(["clone", "--bare", source, join(root, "remote", "octo", "hello.git")], {
    cwd: root,
  });
  remoteBase = `${pathToFileURL(join(root, "remote")).href}/`;

  await writeFile(join(root, "providers.yaml"), PROVIDERS_YAML);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await rm(root, { recursive: true, force: true });
});

/** Fake Pi: answers prompt with disposition "started" and nothing else. No LLM is ever called. */
class FakePi implements PiProcess {
  readonly running = true;
  readonly send = vi.fn(async (command: RpcCommandInput) =>
    command.type === "prompt" ? { disposition: "started" } : undefined,
  );
  readonly respondUi = vi.fn();
  readonly stop = vi.fn(async () => undefined);
}

function gatewayConfig(): GatewayConfig {
  return {
    port: 8090,
    dataDir: join(root, "data"),
    providersFile: join(root, "providers.yaml"),
    notificationsFile: join(root, "notifications.yaml"),
    webFile: join(root, "web.yaml"),
    extensionsDir: loadGatewayConfig({}).extensionsDir,
    webUiDir: join(root, "web-ui"),
    gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid",
    idleTimeoutMs: 1_800_000,
  };
}

function edgeConfig(askTimeoutMs: number): EdgeConfig {
  return {
    token: TOKEN,
    gatewayUrl: GATEWAY_URL,
    dataDir: join(root, "edge-data"),
    apiPort: 8080,
    proxyPort: 8128,
    providersFile: join(root, "no-providers.yaml"),
    notificationsFile: join(root, "no-notifications.yaml"),
    webFile: join(root, "no-web.yaml"),
    askTimeoutMs,
  };
}

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

/** Local echo server: stands in for the public destination behind the validated IP. */
async function startEchoServer(): Promise<number> {
  const echo = track(
    createServer((socket) => {
      socket.on("error", () => undefined);
      socket.pipe(socket);
    }),
  );
  return listen(echo);
}

function headersOf(init: ConstructorParameters<typeof Headers>[0]): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

/** Names of the test: every one ends with ".example" and resolves to PUBLIC_IP. */
function resolveTestName(host: string): string[] {
  return host.endsWith(".example") ? [PUBLIC_IP] : [];
}

/** Gateway, edge, and the proxy listening on 127.0.0.1 with a random port. Nothing else is open. */
async function startStack(askTimeoutMs = ASK_TIMEOUT_MS): Promise<Stack> {
  const gateway: GatewayRuntime = await createGatewayRuntime({
    config: gatewayConfig(),
    version: VERSION,
    env: { ...GIT_ENV, PATH: process.env.PATH },
    startPi: vi.fn<(spec: PiLaunchSpec, handlers: RpcBridgeHandlers) => PiProcess>(
      () => new FakePi(),
    ),
    piCli: join(root, "pi", "cli.js"),
    remoteBase,
  });
  cleanups.push(() => gateway.close());

  const gatewayRequests: GatewayRequest[] = [];
  // Edge talks to the real gateway app in-process: no port is opened for the gateway.
  const gatewayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // Headers are read from init below; a Request input would make the token check vacuous.
    if (input instanceof Request) throw new Error("edge is expected to call fetch(url, init)");
    const response = await gateway.app.request(input, init);
    gatewayRequests.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: headersOf(init?.headers),
      status: response.status,
    });
    return response;
  }) as typeof globalThis.fetch;

  const echoPort = await startEchoServer();
  const upstreamHosts: string[] = [];
  const resolved: string[] = [];
  const edge = await createEdgeRuntime({
    config: edgeConfig(askTimeoutMs),
    version: VERSION,
    fetch: gatewayFetch,
    resolver: async (host) => {
      resolved.push(host);
      return resolveTestName(host);
    },
    // The validated IP is recorded; the tunnel goes to the local echo server instead.
    connect: ({ host }) => {
      upstreamHosts.push(host);
      return netConnect({ host: "127.0.0.1", port: echoPort });
    },
    logError: () => undefined,
  });
  cleanups.push(() => edge.close());
  const proxyPort = await listen(track(edge.proxy));

  return {
    edge,
    gatewayRequests,
    upstreamHosts,
    resolved,
    proxyPort,
    dataDir: join(root, "edge-data"),
  };
}

/** Request through edge's ingress. Bearer by default; `bearer: false` sends none. */
interface ApiInit {
  method?: string;
  body?: unknown;
  bearer?: boolean;
}

async function api(edge: EdgeRuntime, path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.bearer !== false) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return edge.ingress.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Polls `read` until it returns a value, or fails after `timeoutMs`. */
async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sessionInfo(edge: EdgeRuntime): Promise<SessionInfo> {
  const response = await api(edge, "/session");
  expect(response.status).toBe(200);
  return (await response.json()) as SessionInfo;
}

async function startSession(edge: EdgeRuntime): Promise<void> {
  const created = await api(edge, "/session", { method: "POST", body: SESSION_BODY });
  expect(created.status).toBe(201);
  await waitFor(async () => {
    const info = await sessionInfo(edge);
    if (info.status === "error") throw new Error(`session failed: ${info.error ?? "unknown"}`);
    return info.status === "running" ? info : undefined;
  }, "session to be running");
}

/**
 * Reads GET /session/events through edge's ingress in the background, parsing the SSE records.
 * `close()` cancels the reader.
 */
class EventStream {
  readonly events: SessionEvent[] = [];
  /** Every decoded byte received, to check that secrets never reach the stream. */
  raw = "";
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
    void this.pump();
  }

  ofType<T extends SessionEvent["type"]>(type: T): Array<Extract<SessionEvent, { type: T }>> {
    return this.events.filter(
      (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
    );
  }

  /** Resolves once `predicate` holds for the events received so far. */
  async waitUntil(predicate: (events: SessionEvent[]) => boolean): Promise<void> {
    await waitFor(() => (predicate(this.events) ? true : undefined), "stream event");
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        const chunk = this.decoder.decode(value, { stream: true });
        this.raw += chunk;
        this.buffer += chunk;
        this.consumeRecords();
      }
    } catch {
      // Cancelled by close(): nothing more to read.
    }
  }

  private consumeRecords(): void {
    let end = this.buffer.indexOf("\n\n");
    while (end !== -1) {
      const record = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      for (const line of record.split("\n")) {
        if (line.startsWith("data: ")) {
          this.events.push((JSON.parse(line.slice("data: ".length)) as StreamEvent).event);
        }
      }
      end = this.buffer.indexOf("\n\n");
    }
  }
}

async function openEvents(edge: EdgeRuntime): Promise<EventStream> {
  const response = await api(edge, "/session/events");
  expect(response.status).toBe(200);
  if (response.body === null) throw new Error("events stream has no body");
  const stream = new EventStream(response.body);
  cleanups.push(() => stream.close());
  return stream;
}

function hasEvent(type: SessionEvent["type"]): (events: SessionEvent[]) => boolean {
  return (events) => events.some((event) => event.type === type);
}

function firstQuestion(stream: EventStream): Question {
  const event = stream.ofType("question")[0];
  if (event === undefined) throw new Error("no question event");
  return event.question;
}

function networkEntriesOf(events: SessionEvent[]): NetworkLogEntry[] {
  return events.flatMap((event) => (event.type === "network" ? [event.entry] : []));
}

/** Types of the events that take part in a network question, in arrival order. */
function networkOrder(stream: EventStream): string[] {
  const relevant = new Set<string>(["question", "question_resolved", "network"]);
  return stream.events.filter((event) => relevant.has(event.type)).map((event) => event.type);
}

/** Requests edge forwarded whose path starts with `prefix`. */
function gatewayRequestsTo(stack: Stack, prefix: string): GatewayRequest[] {
  return stack.gatewayRequests.filter((request) =>
    new URL(request.url).pathname.startsWith(prefix),
  );
}

/** Calls to POST /internal/questions only (not the resolved ones under the same prefix). */
function publishedQuestions(stack: Stack): GatewayRequest[] {
  return stack.gatewayRequests.filter(
    (request) =>
      request.method === "POST" && new URL(request.url).pathname === "/internal/questions",
  );
}

interface OpenConnect {
  /** Resolves with the status the proxy answered and the tunnel socket (only on a response). */
  answered: Promise<{ status: number; socket: Socket }>;
}

/** Sends a CONNECT to the edge proxy, as the test of edge does. */
function openConnect(proxyPort: number, authority: string): OpenConnect {
  const req: ClientRequest = httpRequest({
    host: "127.0.0.1",
    port: proxyPort,
    method: "CONNECT",
    path: authority,
  });
  const answered = new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    req.on("connect", (response: IncomingMessage, socket: Socket) => {
      socket.on("error", () => undefined);
      cleanups.push(() => {
        socket.destroy();
      });
      resolve({ status: response.statusCode ?? 0, socket });
    });
    req.on("error", reject);
  });
  req.end();
  return { answered };
}

/** Sends bytes through an established tunnel and checks the echo. */
async function expectEcho(socket: Socket): Promise<void> {
  const echoed = new Promise<string>((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
  });
  socket.write("ping");
  expect(await echoed).toBe("ping");
}

/** Lines of network.jsonl, or none while the file does not exist yet. */
async function networkLogLines(dataDir: string): Promise<NetworkLogEntry[]> {
  let text: string;
  try {
    text = await readFile(join(dataDir, "network.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NetworkLogEntry);
}

async function waitForLogLine(
  dataDir: string,
  predicate: (entry: NetworkLogEntry) => boolean,
): Promise<NetworkLogEntry> {
  return waitFor(async () => {
    const found = (await networkLogLines(dataDir)).find(predicate);
    return found;
  }, "network.jsonl line");
}

describe("edge and gateway together (ADR-0008)", () => {
  it("asks about a new host and tunnels it once the user allows it once", async () => {
    const stack = await startStack();
    await startSession(stack.edge);
    const events = await openEvents(stack.edge);

    const connect = openConnect(stack.proxyPort, "allowed-once.example:443");
    await events.waitUntil(hasEvent("question"));
    const question = firstQuestion(events);
    expect(question.id).toMatch(/^net-/);
    expect(question).toMatchObject({
      kind: "network",
      method: "select",
      options: ["allow_once", "allow_always", "deny"],
      network: { host: "allowed-once.example", port: 443 },
      timeoutMs: ASK_TIMEOUT_MS,
    });

    const waiting = await sessionInfo(stack.edge);
    expect(waiting.status).toBe("waiting_input");
    expect(waiting.pendingQuestions.map((pending) => pending.id)).toEqual([question.id]);

    const answer = await api(stack.edge, `/session/answers/${question.id}`, {
      method: "POST",
      body: { value: "allow_once" },
    });
    expect(answer.status).toBe(204);

    const connected = await connect.answered;
    expect(connected.status).toBe(200);
    await expectEcho(connected.socket);

    await events.waitUntil(hasEvent("question_resolved"));
    const [resolution] = events.ofType("question_resolved");
    expect(resolution).toMatchObject({ questionId: question.id, outcome: "answered" });
    expect((await sessionInfo(stack.edge)).status).toBe("running");

    // The tunnel is logged when it closes.
    connected.socket.destroy();
    await events.waitUntil((all) =>
      networkEntriesOf(all).some((entry) => entry.reason === "user_once"),
    );
    const entry = networkEntriesOf(events.events).find((item) => item.reason === "user_once");
    expect(entry).toMatchObject({
      method: "CONNECT",
      host: "allowed-once.example",
      port: 443,
      decision: "allow",
    });

    expect(networkOrder(events)).toEqual(["question", "question_resolved", "network"]);
    // The answer never leaves edge (ADR-0008 section 3).
    expect(gatewayRequestsTo(stack, "/session/answers")).toEqual([]);
    expect(publishedQuestions(stack).map((r) => r.status)).toEqual([201]);
    // The upstream connection goes to the validated address, not to the name.
    expect(stack.upstreamHosts).toEqual([PUBLIC_IP]);
    // The token never reaches the events.
    expect(events.raw).not.toContain(TOKEN);
  });

  it("denies the tunnel with 403 when the user denies it", async () => {
    const stack = await startStack();
    await startSession(stack.edge);
    const events = await openEvents(stack.edge);

    const connect = openConnect(stack.proxyPort, "denied.example:443");
    await events.waitUntil(hasEvent("question"));
    const question = firstQuestion(events);

    const answer = await api(stack.edge, `/session/answers/${question.id}`, {
      method: "POST",
      body: { value: "deny" },
    });
    expect(answer.status).toBe(204);

    const connected = await connect.answered;
    expect(connected.status).toBe(403);

    // A denial is logged at once: there is no tunnel to wait for.
    await events.waitUntil((all) =>
      networkEntriesOf(all).some((entry) => entry.reason === "user_denied"),
    );
    const entry = networkEntriesOf(events.events).find((item) => item.reason === "user_denied");
    expect(entry).toMatchObject({ host: "denied.example", port: 443, decision: "deny" });
    // question_resolved and network are two independent posts from edge: only "question first" is guaranteed.
    expect(networkOrder(events)[0]).toBe("question");
    expect(events.ofType("question_resolved")[0]).toMatchObject({ outcome: "answered" });
    expect(stack.upstreamHosts).toEqual([]);
  });

  it("stores allow_always in policy.json and does not ask again for that host", async () => {
    const stack = await startStack();
    await startSession(stack.edge);
    const events = await openEvents(stack.edge);

    const first = openConnect(stack.proxyPort, "allowed-always.example:443");
    await events.waitUntil(hasEvent("question"));
    const question = firstQuestion(events);

    const answer = await api(stack.edge, `/session/answers/${question.id}`, {
      method: "POST",
      body: { value: "allow_always" },
    });
    expect(answer.status).toBe(204);

    const connected = await first.answered;
    expect(connected.status).toBe(200);
    await expectEcho(connected.socket);
    connected.socket.destroy();
    await events.waitUntil((all) =>
      networkEntriesOf(all).some((entry) => entry.reason === "user_always"),
    );

    const policy = JSON.parse(await readFile(join(stack.dataDir, "policy.json"), "utf8")) as {
      allow: string[];
    };
    expect(policy.allow).toEqual(["allowed-always.example"]);

    const second = openConnect(stack.proxyPort, "allowed-always.example:443");
    const reconnected = await second.answered;
    expect(reconnected.status).toBe(200);
    await expectEcho(reconnected.socket);
    reconnected.socket.destroy();
    await events.waitUntil((all) =>
      networkEntriesOf(all).some((entry) => entry.reason === "allowlist"),
    );

    // Only the first connection was asked about.
    expect(events.ofType("question")).toHaveLength(1);
    expect(stack.upstreamHosts).toEqual([PUBLIC_IP, PUBLIC_IP]);
  });

  it("shares one question between concurrent requests to the same destination", async () => {
    const stack = await startStack();
    await startSession(stack.edge);
    const events = await openEvents(stack.edge);

    const first = openConnect(stack.proxyPort, "shared.example:443");
    const second = openConnect(stack.proxyPort, "shared.example:443");
    await events.waitUntil(hasEvent("question"));
    // Both requests must be waiting on the same question before it is answered;
    // otherwise the second one would ask again.
    await waitFor(() => (stack.resolved.length === 2 ? true : undefined), "both requests");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const question = firstQuestion(events);
    const answer = await api(stack.edge, `/session/answers/${question.id}`, {
      method: "POST",
      body: { value: "allow_once" },
    });
    expect(answer.status).toBe(204);

    const [connectedFirst, connectedSecond] = await Promise.all([first.answered, second.answered]);
    expect(connectedFirst.status).toBe(200);
    expect(connectedSecond.status).toBe(200);
    await expectEcho(connectedFirst.socket);
    await expectEcho(connectedSecond.socket);
    connectedFirst.socket.destroy();
    connectedSecond.socket.destroy();

    await events.waitUntil((all) => networkEntriesOf(all).length === 2);
    expect(networkEntriesOf(events.events).map((entry) => entry.reason)).toEqual([
      "user_once",
      "user_once",
    ]);
    expect(events.ofType("question")).toHaveLength(1);
    expect(events.ofType("question_resolved")).toHaveLength(1);
    expect(stack.upstreamHosts).toEqual([PUBLIC_IP, PUBLIC_IP]);
  });

  it("denies without a session, publishes no question and logs no_session", async () => {
    const stack = await startStack();
    const events = await openEvents(stack.edge);

    const connect = openConnect(stack.proxyPort, "unknown.example:443");
    const connected = await connect.answered;
    expect(connected.status).toBe(403);

    // The gateway refused the question: 409 no_session, nothing shown.
    expect(publishedQuestions(stack).map((r) => r.status)).toEqual([409]);
    expect(events.events).toEqual([]);
    expect((await api(stack.edge, "/session")).status).toBe(404);
    expect(stack.upstreamHosts).toEqual([]);

    const entry = await waitForLogLine(stack.dataDir, (line) => line.host === "unknown.example");
    expect(entry).toMatchObject({ decision: "deny", reason: "no_session" });
  });

  it("denies with 403 when nobody answers in time", async () => {
    const stack = await startStack(SHORT_ASK_TIMEOUT_MS);
    await startSession(stack.edge);
    const events = await openEvents(stack.edge);

    const connect = openConnect(stack.proxyPort, "slow.example:443");
    await events.waitUntil(hasEvent("question"));
    const question = firstQuestion(events);
    expect(question.timeoutMs).toBe(SHORT_ASK_TIMEOUT_MS);

    const connected = await connect.answered;
    expect(connected.status).toBe(403);

    await events.waitUntil(hasEvent("question_resolved"));
    expect(events.ofType("question_resolved")[0]).toMatchObject({
      questionId: question.id,
      outcome: "timeout",
    });
    expect(networkOrder(events)[0]).toBe("question");
    expect((await sessionInfo(stack.edge)).status).toBe("running");

    await events.waitUntil((all) =>
      networkEntriesOf(all).some((entry) => entry.reason === "ask_timeout"),
    );
    expect(stack.upstreamHosts).toEqual([]);
  });

  it("answers 409 for a repeated answer and 404 for an unknown net id, without forwarding", async () => {
    const stack = await startStack();
    await startSession(stack.edge);
    const events = await openEvents(stack.edge);

    const connect = openConnect(stack.proxyPort, "deny-twice.example:443");
    await events.waitUntil(hasEvent("question"));
    const question = firstQuestion(events);

    const first = await api(stack.edge, `/session/answers/${question.id}`, {
      method: "POST",
      body: { value: "deny" },
    });
    expect(first.status).toBe(204);
    expect((await connect.answered).status).toBe(403);

    const repeated = await api(stack.edge, `/session/answers/${question.id}`, {
      method: "POST",
      body: { value: "deny" },
    });
    expect(repeated.status).toBe(409);
    expect((await repeated.json()) as ApiError).toEqual({ error: "question_resolved" });

    const unknown = await api(stack.edge, "/session/answers/net-00000000-unknown", {
      method: "POST",
      body: { value: "deny" },
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as ApiError).toEqual({ error: "question_not_found" });

    expect(gatewayRequestsTo(stack, "/session/answers")).toEqual([]);
  });

  it("does not forward /internal/* from the public entry, with or without a token", async () => {
    const stack = await startStack();
    await startSession(stack.edge);

    const forged = {
      question: {
        id: "net-forged",
        kind: "network",
        method: "select",
        title: "Allow network access to evil.example:443?",
        options: ["allow_once", "allow_always", "deny"],
        createdAt: new Date().toISOString(),
        network: { host: "evil.example", port: 443 },
      },
    };

    const withToken = await api(stack.edge, "/internal/questions", {
      method: "POST",
      body: forged,
    });
    expect(withToken.status).toBe(404);
    expect((await withToken.json()) as ApiError).toEqual({ error: "not_found" });

    const withoutToken = await api(stack.edge, "/internal/questions", {
      method: "POST",
      body: forged,
      bearer: false,
    });
    expect(withoutToken.status).toBe(404);
    expect((await withoutToken.json()) as ApiError).toEqual({ error: "not_found" });

    expect(gatewayRequestsTo(stack, "/internal/")).toEqual([]);
    expect((await sessionInfo(stack.edge)).pendingQuestions).toEqual([]);
  });

  it("never sends the API token to the gateway", async () => {
    const stack = await startStack();
    await startSession(stack.edge);

    const info = await api(stack.edge, "/session");
    expect(info.status).toBe(200);
    // The request that carried the Bearer was forwarded, so the check below is not vacuous.
    const created = stack.gatewayRequests.filter(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/session",
    );
    expect(created.map((request) => request.status)).toEqual([201]);

    for (const request of stack.gatewayRequests) {
      expect(request.headers).not.toHaveProperty("authorization");
    }
  });
});
