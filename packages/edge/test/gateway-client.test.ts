import type { NetworkLogEntry, Question } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { createGatewayClient, createReplicaGateways } from "../src/gateway-client.js";
import type { ReplicaTarget } from "../src/replicas.js";

const GATEWAY = "http://gw:8090";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Fake fetch that records calls and answers with `respond()`. */
function fakeFetch(
  respond: (signal: AbortSignal | null | undefined) => Promise<Response> | Response,
) {
  const calls: FetchCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(init?.signal);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const question: Question = {
  id: "net-1",
  kind: "network",
  method: "select",
  title: "Allow network access to example.com:443?",
  options: ["allow_once", "allow_always", "deny"],
  timeoutMs: 120_000,
  createdAt: "2026-11-16T10:00:00.000Z",
  network: { host: "example.com", port: 443 },
};

const entry: NetworkLogEntry = {
  ts: "2026-11-16T10:00:00.000Z",
  method: "CONNECT",
  host: "example.com",
  port: 443,
  decision: "deny",
  reason: "user_denied",
  bytesOut: 10,
  bytesIn: 20,
  durationMs: 5,
};

describe("publishQuestion", () => {
  it("POSTs {question} to /internal/questions with a JSON body", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 201 }));
    const client = createGatewayClient({ gatewayUrl: GATEWAY, fetch: gw.fetch });

    await client.publishQuestion(question);

    expect(gw.calls).toHaveLength(1);
    const [call] = gw.calls;
    expect(call?.url).toBe("http://gw:8090/internal/questions");
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ question });
  });

  it("returns true only on 201", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 201 }));
    const client = createGatewayClient({ gatewayUrl: GATEWAY, fetch: gw.fetch });
    expect(await client.publishQuestion(question)).toBe(true);
  });

  it("returns false on 409 (no session)", async () => {
    const gw = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: "no_session" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createGatewayClient({ gatewayUrl: GATEWAY, fetch: gw.fetch });
    expect(await client.publishQuestion(question)).toBe(false);
  });

  it("returns false on any other status", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 200 }));
    const client = createGatewayClient({ gatewayUrl: GATEWAY, fetch: gw.fetch });
    expect(await client.publishQuestion(question)).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    const client = createGatewayClient({
      gatewayUrl: GATEWAY,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });
    expect(await client.publishQuestion(question)).toBe(false);
  });

  it("returns false when the gateway never answers within timeoutMs", async () => {
    const gw = fakeFetch(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const client = createGatewayClient({
      gatewayUrl: GATEWAY,
      fetch: gw.fetch,
      timeoutMs: 50,
    });
    expect(await client.publishQuestion(question)).toBe(false);
    expect(gw.calls[0]?.init?.signal?.aborted).toBe(true);
  });
});

describe("resolveQuestion", () => {
  it("POSTs {outcome} to the encoded resolved route", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createGatewayClient({ gatewayUrl: GATEWAY, fetch: gw.fetch });

    await client.resolveQuestion("net-a b", "timeout");

    const [call] = gw.calls;
    expect(call?.url).toBe("http://gw:8090/internal/questions/net-a%20b/resolved");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ outcome: "timeout" });
  });

  it("does not throw when fetch throws", async () => {
    const client = createGatewayClient({
      gatewayUrl: GATEWAY,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });
    await expect(client.resolveQuestion("net-1", "answered")).resolves.toBeUndefined();
  });
});

describe("publishNetworkEntry", () => {
  it("POSTs {entry} to /internal/network", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createGatewayClient({ gatewayUrl: GATEWAY, fetch: gw.fetch });

    await client.publishNetworkEntry(entry);

    const [call] = gw.calls;
    expect(call?.url).toBe("http://gw:8090/internal/network");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ entry });
  });

  it("does not throw when fetch throws", async () => {
    const client = createGatewayClient({
      gatewayUrl: GATEWAY,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });
    await expect(client.publishNetworkEntry(entry)).resolves.toBeUndefined();
  });
});

describe("createReplicaGateways", () => {
  const replicas: ReplicaTarget[] = [
    { name: "agent-1", gatewayUrl: "http://agent-1:8090" },
    { name: "agent-2", gatewayUrl: "http://agent-2:8090" },
  ];

  it("sends each publishQuestion to the gateway of its replica", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 201 }));
    const gateways = createReplicaGateways({ replicas, fetch: gw.fetch });

    await expect(gateways.publishQuestion("agent-1", question)).resolves.toBe(true);
    await expect(gateways.publishQuestion("agent-2", question)).resolves.toBe(true);

    expect(gw.calls.map((call) => call.url)).toEqual([
      "http://agent-1:8090/internal/questions",
      "http://agent-2:8090/internal/questions",
    ]);
  });

  it("sends resolveQuestion and publishNetworkEntry to the gateway of their replica", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 204 }));
    const gateways = createReplicaGateways({ replicas, fetch: gw.fetch });

    await gateways.resolveQuestion("agent-2", "net-1", "timeout");
    await gateways.publishNetworkEntry("agent-1", entry);

    expect(gw.calls.map((call) => call.url)).toEqual([
      "http://agent-2:8090/internal/questions/net-1/resolved",
      "http://agent-1:8090/internal/network",
    ]);
  });

  it("publishQuestion for an unknown replica is false and sends nothing", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 201 }));
    const gateways = createReplicaGateways({ replicas, fetch: gw.fetch });

    await expect(gateways.publishQuestion("agent-9", question)).resolves.toBe(false);
    expect(gw.calls).toHaveLength(0);
  });

  it("resolveQuestion and publishNetworkEntry for an unknown replica are no-ops that never reject", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 204 }));
    const gateways = createReplicaGateways({ replicas, fetch: gw.fetch });

    await expect(gateways.resolveQuestion("agent-9", "net-1", "answered")).resolves.toBeUndefined();
    await expect(gateways.publishNetworkEntry("agent-9", entry)).resolves.toBeUndefined();
    expect(gw.calls).toHaveLength(0);
  });

  it("treats __proto__ as an unknown replica", async () => {
    const gw = fakeFetch(() => new Response(null, { status: 201 }));
    const gateways = createReplicaGateways({ replicas, fetch: gw.fetch });

    await expect(gateways.publishQuestion("__proto__", question)).resolves.toBe(false);
    await expect(
      gateways.resolveQuestion("__proto__", "net-1", "answered"),
    ).resolves.toBeUndefined();
    await expect(gateways.publishNetworkEntry("__proto__", entry)).resolves.toBeUndefined();
    expect(gw.calls).toHaveLength(0);
  });

  it("returns false, without throwing, when the replica's gateway fails", async () => {
    const gateways = createReplicaGateways({
      replicas,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });

    await expect(gateways.publishQuestion("agent-1", question)).resolves.toBe(false);
    await expect(gateways.publishNetworkEntry("agent-1", entry)).resolves.toBeUndefined();
  });
});
