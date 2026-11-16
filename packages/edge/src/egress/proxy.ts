import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type {
  NetworkDecision,
  NetworkDecisionReason,
  NetworkLogEntry,
  NetworkMethod,
} from "@cna/shared";
import type { NetworkLog } from "./log.js";
import { type Policy, type Resolver, systemResolver } from "./policy.js";
import { type ProxyTarget, parseConnectAuthority, parseHttpProxyUrl } from "./target.js";

export interface EgressProxyOptions {
  policy: Policy;
  log: NetworkLog;
  /** Defaults to systemResolver. */
  resolver?: Resolver;
  /** Opens the upstream TCP connection to an already validated IP. Defaults to net.connect({ host, port }). Injectable for tests. */
  connect?: (target: { host: string; port: number }) => Socket;
  /** Upstream connect timeout in ms. Default 10_000. */
  connectTimeoutMs?: number;
}

interface ProxyContext {
  readonly policy: Policy;
  readonly log: NetworkLog;
  readonly resolver: Resolver;
  readonly connect: (target: ProxyTarget) => Socket;
  readonly connectTimeoutMs: number;
}

/** Mutable record of one proxied connection or request. Written to the log once, when it ends. */
interface Exchange {
  readonly method: NetworkMethod;
  readonly startedAt: number;
  readonly ts: string;
  host: string;
  port: number;
  decision: NetworkDecision;
  reason: NetworkDecisionReason;
  bytesOut: number;
  bytesIn: number;
  error?: string;
}

const CONNECT_REASONS = { 400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway" } as const;
const HTTP_BODIES = {
  400: "bad request",
  403: "forbidden by egress policy",
  502: "bad gateway",
} as const;
type ErrorStatus = keyof typeof CONNECT_REASONS;

const CONNECT_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";
const CLIENT_ERROR_RESPONSE =
  "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * Egress proxy of `edge` (ADR-0004): CONNECT tunnels (HTTPS, no TLS interception) and
 * absolute-form HTTP requests. Every target goes through the policy on its resolved addresses,
 * and the connection goes to the first validated address: the name is never resolved again
 * (DNS rebinding). Returns a server that is not listening yet; the caller calls `listen()`.
 */
export function createEgressProxy(options: EgressProxyOptions): Server {
  const context: ProxyContext = {
    policy: options.policy,
    log: options.log,
    resolver: options.resolver ?? systemResolver,
    connect: options.connect ?? ((target) => netConnect({ host: target.host, port: target.port })),
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
  };
  const server = createServer();

  server.on("connect", (req, socket, head) => {
    const client = socket as Socket;
    client.on("error", () => client.destroy());
    const exchange = newExchange("CONNECT");
    void settle(
      context,
      exchange,
      () => handleConnect(context, req.url ?? "", client, head, exchange),
      () => client.destroy(),
    );
  });

  server.on("request", (req, res) => {
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    const exchange = newExchange("HTTP");
    void settle(
      context,
      exchange,
      () => handleHttp(context, req, res, exchange),
      () => res.destroy(),
    );
  });

  server.on("clientError", (_error, socket) => {
    socket.on("error", () => socket.destroy());
    if (socket.writable) {
      socket.end(CLIENT_ERROR_RESPONSE, () => socket.destroy());
    } else {
      socket.destroy();
    }
  });

  return server;
}

function newExchange(method: NetworkMethod): Exchange {
  const startedAt = Date.now();
  return {
    method,
    startedAt,
    ts: new Date(startedAt).toISOString(),
    host: "",
    port: 0,
    decision: "deny",
    reason: "invalid_target",
    bytesOut: 0,
    bytesIn: 0,
  };
}

/** Runs one exchange and writes its log entry exactly once, when it ends. Never rejects. */
async function settle(
  context: ProxyContext,
  exchange: Exchange,
  body: () => Promise<void>,
  abort: () => void,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    exchange.error ??= errorLabel(error);
    abort();
  } finally {
    writeEntry(context.log, exchange);
  }
}

function writeEntry(log: NetworkLog, exchange: Exchange): void {
  const entry: NetworkLogEntry = {
    ts: exchange.ts,
    method: exchange.method,
    host: exchange.host,
    port: exchange.port,
    decision: exchange.decision,
    reason: exchange.reason,
    bytesOut: exchange.bytesOut,
    bytesIn: exchange.bytesIn,
    durationMs: Date.now() - exchange.startedAt,
  };
  if (exchange.error !== undefined) entry.error = exchange.error;
  // The log handles its own write errors; this only keeps a rejection from becoming unhandled.
  log.append(entry).catch(() => {
    console.error("network log: append failed");
  });
}

/** Error code (ETIMEDOUT, ECONNREFUSED...) or message. Never headers or bodies. */
function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === "string" ? code : error.message;
}

/** Resolves the host and applies the policy, recording the decision in `exchange`. Returns the resolved addresses. */
async function decide(
  context: ProxyContext,
  exchange: Exchange,
  target: ProxyTarget,
): Promise<string[]> {
  const addresses = await context.resolver(target.host).catch(() => []);
  const result = await context.policy({ host: target.host, port: target.port, addresses });
  exchange.host = target.host;
  exchange.port = target.port;
  exchange.decision = result.decision;
  exchange.reason = result.reason;
  return addresses;
}

/** Fails the upstream connection with ETIMEDOUT if it is not established within the timeout. */
function armConnectTimeout(socket: Socket, timeoutMs: number): void {
  const timer = setTimeout(() => {
    socket.destroy(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
  }, timeoutMs);
  socket.once("connect", () => clearTimeout(timer));
  socket.once("close", () => clearTimeout(timer));
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("close", () => reject(new Error("closed before connect")));
  });
}

function rejectConnect(socket: Socket, status: ErrorStatus): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${CONNECT_REASONS[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

async function handleConnect(
  context: ProxyContext,
  authority: string,
  client: Socket,
  head: Buffer,
  exchange: Exchange,
): Promise<void> {
  let clientClosed = false;
  let upstream: Socket | undefined;
  client.once("close", () => {
    clientClosed = true;
    upstream?.destroy();
  });

  const target = parseConnectAuthority(authority);
  if (target === null) {
    rejectConnect(client, 400);
    return;
  }
  const addresses = await decide(context, exchange, target);
  if (clientClosed) return;
  if (exchange.decision === "deny") {
    rejectConnect(client, 403);
    return;
  }
  const address = addresses[0];
  if (address === undefined) {
    exchange.error = "no_address";
    rejectConnect(client, 502);
    return;
  }

  const socket = context.connect({ host: address, port: target.port });
  upstream = socket;
  socket.on("error", (error) => {
    if (!clientClosed) exchange.error ??= errorLabel(error);
  });
  armConnectTimeout(socket, context.connectTimeoutMs);
  try {
    await waitForConnect(socket);
  } catch {
    if (!clientClosed) {
      exchange.error ??= "closed_before_connect";
      rejectConnect(client, 502);
    }
    return;
  }
  // The client may have left in the same tick as the connection was established.
  if (clientClosed) {
    socket.destroy();
    return;
  }

  exchange.bytesOut += head.length;
  client.write(CONNECT_ESTABLISHED);
  if (head.length > 0) socket.write(head);
  client.on("data", (chunk: Buffer) => {
    exchange.bytesOut += chunk.length;
  });
  socket.on("data", (chunk: Buffer) => {
    exchange.bytesIn += chunk.length;
  });
  client.pipe(socket);
  socket.pipe(client);

  // The tunnel ends when both sides are closed; closing one side closes the other.
  await new Promise<void>((resolve) => {
    let open = 2;
    const closed = () => {
      open -= 1;
      if (open === 0) resolve();
    };
    client.once("close", closed);
    socket.once("close", () => {
      client.destroy();
      closed();
    });
  });
}

async function handleHttp(
  context: ProxyContext,
  req: IncomingMessage,
  res: ServerResponse,
  exchange: Exchange,
): Promise<void> {
  let clientGone = false;
  res.once("close", () => {
    clientGone = true;
  });

  const target = parseHttpProxyUrl(req.url ?? "");
  if (target === null) {
    sendText(res, 400);
    return;
  }
  const addresses = await decide(context, exchange, target);
  if (clientGone) return;
  if (exchange.decision === "deny") {
    sendText(res, 403);
    return;
  }
  const address = addresses[0];
  if (address === undefined) {
    exchange.error = "no_address";
    sendText(res, 502);
    return;
  }
  await forward(context, req, res, { ...target, address }, exchange);
}

/** Forwards one absolute-form request. Resolves when the response has ended or the exchange failed. */
function forward(
  context: ProxyContext,
  req: IncomingMessage,
  res: ServerResponse,
  upstreamTarget: ProxyTarget & { path: string; address: string },
  exchange: Exchange,
): Promise<void> {
  const { address, path } = upstreamTarget;
  return new Promise<void>((resolve) => {
    let done = false;
    let upstreamRes: IncomingMessage | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const fail = (error: Error) => {
      if (done) return;
      exchange.error ??= errorLabel(error);
      upstreamReq.destroy();
      upstreamRes?.destroy();
      if (res.headersSent) {
        res.destroy();
      } else {
        sendText(res, 502);
      }
      finish();
    };

    const upstreamReq = httpRequest({
      host: address,
      port: upstreamTarget.port,
      method: req.method ?? "GET",
      path,
      headers: { ...forwardableHeaders(req.headers), host: hostHeader(upstreamTarget) },
      setHost: false,
      // Given as createConnection (no agent): the socket is opened to the validated IP only.
      createConnection: () => {
        const socket = context.connect({ host: address, port: upstreamTarget.port });
        armConnectTimeout(socket, context.connectTimeoutMs);
        return socket;
      },
    });
    upstreamReq.on("error", fail);
    upstreamReq.on("response", (response) => {
      upstreamRes = response;
      response.on("data", (chunk: Buffer) => {
        exchange.bytesIn += chunk.length;
      });
      response.on("error", fail);
      response.once("close", () => {
        if (!response.complete) {
          fail(Object.assign(new Error("upstream response aborted"), { code: "ECONNRESET" }));
        }
      });
      res.writeHead(response.statusCode ?? 502, forwardableHeaders(response.headers));
      response.pipe(res);
    });

    req.on("data", (chunk: Buffer) => {
      exchange.bytesOut += chunk.length;
    });
    req.pipe(upstreamReq);

    // The response closes when it completes or when the client leaves. In both cases the
    // upstream side is no longer needed.
    res.once("close", () => {
      finish();
      upstreamReq.destroy();
      upstreamRes?.destroy();
    });
  });
}

function sendText(res: ServerResponse, status: ErrorStatus): void {
  const body = HTTP_BODIES[status];
  res.writeHead(status, {
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Host header for the upstream request: the original host, with the port unless it is 80. */
function hostHeader(target: ProxyTarget): string {
  const name = target.host.includes(":") ? `[${target.host}]` : target.host;
  return target.port === 80 ? name : `${name}:${target.port}`;
}

/** Copies headers without the hop-by-hop ones, including those named in `Connection`. */
function forwardableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === "host") continue;
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}
