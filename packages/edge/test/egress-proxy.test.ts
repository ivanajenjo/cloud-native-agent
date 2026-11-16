import type { Server as HttpServer, IncomingMessage } from "node:http";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { Server } from "node:net";
import { type AddressInfo, connect, createServer, Socket } from "node:net";
import type { NetworkLogEntry } from "@cna/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkLog } from "../src/egress/log.js";
import { createAuditPolicy, type Policy } from "../src/egress/policy.js";
import { createEgressProxy } from "../src/egress/proxy.js";

type AnyServer = Server | HttpServer;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Destroys the server's open connections and closes it, so afterEach never hangs. */
function track<T extends AnyServer>(server: T): T {
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

async function listen(server: AnyServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Plain TCP echo server. `closed` counts upstream sockets that have closed. */
async function startEcho(): Promise<{ port: number; closed: () => number }> {
  let closedCount = 0;
  const server = track(
    createServer((socket) => {
      socket.on("close", () => {
        closedCount += 1;
      });
      socket.pipe(socket);
    }),
  );
  const port = await listen(server);
  return { port, closed: () => closedCount };
}

interface Origin {
  port: number;
  requests: IncomingMessage[];
  bodies: Buffer[];
}

/** HTTP origin that answers 200 with a fixed body and records the requests it receives. */
async function startOrigin(body = "hello body"): Promise<Origin> {
  const origin: Origin = { port: 0, requests: [], bodies: [] };
  const server = track(
    createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        origin.requests.push(req);
        origin.bodies.push(Buffer.concat(chunks));
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      });
    }),
  );
  origin.port = await listen(server);
  return origin;
}

const RESOLVED: Record<string, string[]> = {
  "example.test": ["127.0.0.1"],
  "nxdomain.test": [],
};
const resolver = async (host: string): Promise<string[]> => RESOLVED[host] ?? [];

const allowAll: Policy = () => ({ decision: "allow", reason: "audit" });

interface Harness {
  port: number;
  entries: NetworkLogEntry[];
  server: AnyServer;
}

/** Starts the proxy with a log that keeps its entries in memory. */
async function startProxy(
  options: Partial<Parameters<typeof createEgressProxy>[0]> = {},
): Promise<Harness> {
  const entries: NetworkLogEntry[] = [];
  const log: NetworkLog = {
    append: async (entry) => {
      entries.push(entry);
    },
    close: async () => undefined,
  };
  const server = track(
    createEgressProxy({ policy: allowAll, log, resolver, connectTimeoutMs: 2000, ...options }),
  );
  const port = await listen(server);
  return { port, entries, server };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Tunnel {
  socket: Socket;
  status: number;
  /** Every byte received from the proxy, including the CONNECT response head. */
  received: Buffer[];
}

/** Sends CONNECT (optionally with extra bytes in the same write) and waits for the response head. */
async function openTunnel(port: number, authority: string, initial?: Buffer): Promise<Tunnel> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  const received: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => received.push(chunk));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const headers = Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  socket.write(initial ? Buffer.concat([headers, initial]) : headers);
  await waitUntil(() => Buffer.concat(received).includes("\r\n\r\n"));
  const status = Number(Buffer.concat(received).toString("latin1", 9, 12));
  return { socket, status, received };
}

/** Sends a raw request to the proxy and returns the status line and the body after the head. */
async function rawRequest(
  port: number,
  method: string,
  target: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: target }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("egress proxy: CONNECT", () => {
  it("tunnels bytes in both directions and logs the connection", async () => {
    const echo = await startEcho();
    const proxy = await startProxy();
    const tunnel = await openTunnel(proxy.port, `example.test:${echo.port}`);
    expect(tunnel.status).toBe(200);

    tunnel.socket.write("hello tunnel");
    await waitUntil(() => Buffer.concat(tunnel.received).toString().endsWith("hello tunnel"));
    tunnel.socket.end();

    await waitUntil(() => proxy.entries.length === 1);
    expect(proxy.entries[0]).toMatchObject({
      method: "CONNECT",
      host: "example.test",
      port: echo.port,
      decision: "allow",
      bytesOut: 12,
      bytesIn: 12,
    });
    expect(proxy.entries[0]?.error).toBeUndefined();
  });

  it("forwards bytes sent in the same packet as the CONNECT head and counts them", async () => {
    const echo = await startEcho();
    const proxy = await startProxy();
    const tunnel = await openTunnel(
      proxy.port,
      `example.test:${echo.port}`,
      Buffer.from("early bytes"),
    );
    expect(tunnel.status).toBe(200);
    await waitUntil(() => Buffer.concat(tunnel.received).toString().endsWith("early bytes"));
    tunnel.socket.end();

    await waitUntil(() => proxy.entries.length === 1);
    expect(proxy.entries[0]?.bytesOut).toBe("early bytes".length);
    expect(proxy.entries[0]?.bytesIn).toBe("early bytes".length);
  });

  it("connects to the validated address and never resolves the name again", async () => {
    const echo = await startEcho();
    const resolve = vi.fn(resolver);
    const connectSpy = vi.fn((target: { host: string; port: number }) => connect(target));
    const proxy = await startProxy({ resolver: resolve, connect: connectSpy });

    const tunnel = await openTunnel(proxy.port, `example.test:${echo.port}`);
    expect(tunnel.status).toBe(200);
    tunnel.socket.end();
    await waitUntil(() => proxy.entries.length === 1);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy.mock.calls[0]?.[0]).toEqual({ host: "127.0.0.1", port: echo.port });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("answers 403 and never connects when the policy denies", async () => {
    const deny: Policy = () => ({ decision: "deny", reason: "port_not_allowed" });
    const connectSpy = vi.fn((target: { host: string; port: number }) => connect(target));
    const proxy = await startProxy({ policy: deny, connect: connectSpy });

    const tunnel = await openTunnel(proxy.port, "example.test:443");
    expect(tunnel.status).toBe(403);
    await waitUntil(() => proxy.entries.length === 1);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(proxy.entries[0]).toMatchObject({
      method: "CONNECT",
      decision: "deny",
      reason: "port_not_allowed",
    });
  });

  it("applies the real audit policy: internal address and disallowed port", async () => {
    const echo = await startEcho();
    const proxy = await startProxy({ policy: createAuditPolicy({ allowedPorts: [echo.port] }) });

    const internal = await openTunnel(proxy.port, `example.test:${echo.port}`);
    expect(internal.status).toBe(403);
    const port22 = await openTunnel(proxy.port, "example.test:22");
    expect(port22.status).toBe(403);
    await waitUntil(() => proxy.entries.length === 2);

    expect(proxy.entries[0]).toMatchObject({ decision: "deny", reason: "internal_destination" });
    expect(proxy.entries[1]).toMatchObject({ decision: "deny", reason: "port_not_allowed" });
  });

  it("denies a name that does not resolve with dns_error", async () => {
    const echo = await startEcho();
    const proxy = await startProxy({ policy: createAuditPolicy({ allowedPorts: [echo.port] }) });

    const tunnel = await openTunnel(proxy.port, `nxdomain.test:${echo.port}`);
    expect(tunnel.status).toBe(403);
    await waitUntil(() => proxy.entries.length === 1);

    expect(proxy.entries[0]).toMatchObject({
      host: "nxdomain.test",
      decision: "deny",
      reason: "dns_error",
    });
  });

  it("answers 400 and logs invalid_target for an unparseable authority", async () => {
    const proxy = await startProxy();

    const tunnel = await openTunnel(proxy.port, "nonsense");
    expect(tunnel.status).toBe(400);
    await waitUntil(() => proxy.entries.length === 1);

    expect(proxy.entries[0]).toMatchObject({
      method: "CONNECT",
      host: "",
      port: 0,
      decision: "deny",
      reason: "invalid_target",
    });
  });

  it("answers 502 and logs the error when the upstream port is closed", async () => {
    const closedServer = createServer();
    const closedPort = await listen(closedServer);
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));
    const proxy = await startProxy();

    const tunnel = await openTunnel(proxy.port, `example.test:${closedPort}`);
    expect(tunnel.status).toBe(502);
    await waitUntil(() => proxy.entries.length === 1);

    expect(proxy.entries[0]?.decision).toBe("allow");
    expect(proxy.entries[0]?.error).toBeDefined();
  });

  it("answers 502 and logs ETIMEDOUT when the upstream never connects", async () => {
    // A socket that is never connected, so the connect timeout fires.
    const hanging = vi.fn(() => new Socket());
    const proxy = await startProxy({ connect: hanging, connectTimeoutMs: 100 });

    const tunnel = await openTunnel(proxy.port, "example.test:9");
    expect(tunnel.status).toBe(502);
    await waitUntil(() => proxy.entries.length === 1);

    expect(proxy.entries[0]?.error).toBe("ETIMEDOUT");
  });

  it("destroys the upstream and logs once when the client drops mid-tunnel", async () => {
    const echo = await startEcho();
    const proxy = await startProxy();
    const tunnel = await openTunnel(proxy.port, `example.test:${echo.port}`);
    tunnel.socket.write("data");
    await waitUntil(() => Buffer.concat(tunnel.received).toString().endsWith("data"));

    tunnel.socket.destroy();

    await waitUntil(() => echo.closed() === 1);
    await waitUntil(() => proxy.entries.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proxy.entries).toHaveLength(1);
  });

  it("handles concurrent tunnels with one log entry each", async () => {
    const echo = await startEcho();
    const proxy = await startProxy();

    const tunnels = await Promise.all(
      Array.from({ length: 5 }, () => openTunnel(proxy.port, `example.test:${echo.port}`)),
    );
    for (const tunnel of tunnels) {
      expect(tunnel.status).toBe(200);
      tunnel.socket.write("ping");
    }
    await waitUntil(() =>
      tunnels.every((tunnel) => Buffer.concat(tunnel.received).toString().endsWith("ping")),
    );
    for (const tunnel of tunnels) tunnel.socket.end();

    await waitUntil(() => proxy.entries.length === 5);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proxy.entries).toHaveLength(5);
    expect(proxy.entries.every((entry) => entry.bytesOut === 4 && entry.bytesIn === 4)).toBe(true);
  });
});

describe("egress proxy: HTTP absolute form", () => {
  it("forwards the request without proxy headers and streams the response", async () => {
    const origin = await startOrigin("hello body");
    const proxy = await startProxy();

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: `http://example.test:${origin.port}/a?b=1`,
          headers: { "proxy-authorization": "Basic c2VjcmV0", "proxy-connection": "keep-alive" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(res).toEqual({ status: 200, body: "hello body" });
    const received = origin.requests[0];
    expect(received?.url).toBe("/a?b=1");
    expect(received?.headers.host).toBe(`example.test:${origin.port}`);
    expect(received?.headers["proxy-authorization"]).toBeUndefined();
    expect(received?.headers["proxy-connection"]).toBeUndefined();

    await waitUntil(() => proxy.entries.length === 1);
    expect(proxy.entries[0]).toMatchObject({
      method: "HTTP",
      host: "example.test",
      port: origin.port,
      decision: "allow",
      bytesIn: "hello body".length,
    });
  });

  it("forwards a 64 KiB POST body intact and counts it as bytesOut", async () => {
    const origin = await startOrigin("ok");
    const proxy = await startProxy();
    const payload = Buffer.alloc(65536, 0x61);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "POST",
          path: `http://example.test:${origin.port}/upload`,
          headers: { "content-length": payload.length, "content-type": "application/octet-stream" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

    expect(status).toBe(200);
    expect(origin.bodies[0]?.equals(payload)).toBe(true);
    await waitUntil(() => proxy.entries.length === 1);
    expect(proxy.entries[0]?.bytesOut).toBe(65536);
  });

  it("answers 400 and logs invalid_target for an origin-form request", async () => {
    const proxy = await startProxy();

    const res = await rawRequest(proxy.port, "GET", "/");
    expect(res.status).toBe(400);
    expect(res.body).toBe("bad request");
    await waitUntil(() => proxy.entries.length === 1);

    expect(proxy.entries[0]).toMatchObject({
      method: "HTTP",
      host: "",
      port: 0,
      decision: "deny",
      reason: "invalid_target",
    });
  });

  it("answers 403 with the policy body and never connects when denied", async () => {
    const deny: Policy = () => ({ decision: "deny", reason: "internal_destination" });
    const connectSpy = vi.fn((target: { host: string; port: number }) => connect(target));
    const proxy = await startProxy({ policy: deny, connect: connectSpy });

    const res = await rawRequest(proxy.port, "GET", "http://example.test:80/");
    expect(res.status).toBe(403);
    expect(res.body).toBe("forbidden by egress policy");
    await waitUntil(() => proxy.entries.length === 1);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(proxy.entries[0]).toMatchObject({ decision: "deny", reason: "internal_destination" });
  });
});
