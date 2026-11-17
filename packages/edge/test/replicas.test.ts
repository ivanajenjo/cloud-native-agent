import { describe, expect, it } from "vitest";
import type { Resolver } from "../src/egress/policy.js";
import {
  createReplicaDirectory,
  fetchReplicaSummaries,
  normalizeAddress,
  type ReplicaTarget,
} from "../src/replicas.js";

const AGENT_1: ReplicaTarget = { name: "agent-1", gatewayUrl: "http://agent-1:8090" };
const AGENT_2: ReplicaTarget = { name: "agent-2", gatewayUrl: "http://agent-2:8090" };

/**
 * Resolver that counts its calls. `table` maps a host to its addresses; it can be changed
 * between calls, and a value that is an Error makes the lookup reject.
 */
function fakeResolver(table: Record<string, string[] | Error>): {
  resolver: Resolver;
  calls: string[];
} {
  const calls: string[] = [];
  const resolver: Resolver = async (host) => {
    calls.push(host);
    const value = table[host];
    if (value === undefined) {
      return [];
    }
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  return { resolver, calls };
}

describe("normalizeAddress", () => {
  it.each([
    ["::ffff:172.18.0.3", "172.18.0.3"],
    ["::FFFF:10.0.0.1", "10.0.0.1"],
    ["::ffff:abcd", "::ffff:abcd"],
    ["FE80::1%eth0", "fe80::1"],
    ["172.18.0.3", "172.18.0.3"],
    ["", ""],
  ])("normalizes %j to %j", (address, expected) => {
    expect(normalizeAddress(address)).toBe(expected);
  });
});

describe("createReplicaDirectory identify", () => {
  it("returns the replica name of each address", async () => {
    const { resolver } = fakeResolver({
      "agent-1": ["172.18.0.2"],
      "agent-2": ["172.19.0.2"],
    });
    const directory = createReplicaDirectory({ replicas: [AGENT_1, AGENT_2], resolver });
    expect(await directory.identify("172.18.0.2")).toBe("agent-1");
    expect(await directory.identify("172.19.0.2")).toBe("agent-2");
  });

  it("accepts the source address as an IPv4-mapped IPv6 address", async () => {
    const { resolver } = fakeResolver({
      "agent-1": ["172.18.0.2"],
      "agent-2": ["172.19.0.2"],
    });
    const directory = createReplicaDirectory({ replicas: [AGENT_1, AGENT_2], resolver });
    expect(await directory.identify("::ffff:172.19.0.2")).toBe("agent-2");
  });

  it("returns null for an unknown address", async () => {
    const { resolver } = fakeResolver({ "agent-1": ["172.18.0.2"] });
    const directory = createReplicaDirectory({ replicas: [AGENT_1], resolver });
    expect(await directory.identify("172.18.0.99")).toBe(null);
  });

  it("returns null for an empty address without resolving", async () => {
    const { resolver, calls } = fakeResolver({ "agent-1": ["172.18.0.2"] });
    const directory = createReplicaDirectory({ replicas: [AGENT_1], resolver });
    expect(await directory.identify("")).toBe(null);
    expect(calls).toEqual([]);
  });

  it("does not resolve again for an address already in the cache", async () => {
    const { resolver, calls } = fakeResolver({ "agent-1": ["172.18.0.2"] });
    const directory = createReplicaDirectory({ replicas: [AGENT_1], resolver });
    expect(await directory.identify("172.18.0.2")).toBe("agent-1");
    expect(calls).toEqual(["agent-1"]);
    expect(await directory.identify("172.18.0.2")).toBe("agent-1");
    expect(calls).toEqual(["agent-1"]);
  });

  it("does not resolve for an unknown address within the minimum interval", async () => {
    let clock = 0;
    const { resolver, calls } = fakeResolver({ "agent-1": ["172.18.0.2"] });
    const directory = createReplicaDirectory({
      replicas: [AGENT_1],
      resolver,
      minRefreshIntervalMs: 1000,
      now: () => clock,
    });
    expect(await directory.identify("172.18.0.2")).toBe("agent-1");
    expect(calls).toHaveLength(1);

    clock = 500;
    expect(await directory.identify("172.18.0.99")).toBe(null);
    expect(calls).toHaveLength(1);
  });

  it("forgets the old address of a restarted replica", async () => {
    let clock = 0;
    const table: Record<string, string[]> = { "agent-1": ["172.18.0.2"] };
    const { resolver } = fakeResolver(table);
    const directory = createReplicaDirectory({
      replicas: [AGENT_1],
      resolver,
      minRefreshIntervalMs: 1000,
      now: () => clock,
    });
    expect(await directory.identify("172.18.0.2")).toBe("agent-1");

    // The container restarts with another address.
    table["agent-1"] = ["172.18.0.5"];
    clock = 1000;
    expect(await directory.identify("172.18.0.5")).toBe("agent-1");

    // The old address is no longer in the new cache.
    clock = 2000;
    expect(await directory.identify("172.18.0.2")).toBe(null);
  });

  it("shares a single refresh between concurrent identify calls", async () => {
    const { resolver, calls } = fakeResolver({
      "agent-1": ["172.18.0.2"],
      "agent-2": ["172.19.0.2"],
    });
    const directory = createReplicaDirectory({ replicas: [AGENT_1, AGENT_2], resolver });
    const [first, second] = await Promise.all([
      directory.identify("172.18.0.99"),
      directory.identify("172.19.0.99"),
    ]);
    expect(first).toBe(null);
    expect(second).toBe(null);
    expect(calls.filter((host) => host === "agent-1")).toHaveLength(1);
    expect(calls.filter((host) => host === "agent-2")).toHaveLength(1);
  });

  it("returns null for an address that two replicas resolve to, and works for the rest", async () => {
    const { resolver } = fakeResolver({
      "agent-1": ["172.18.0.2", "172.18.0.9"],
      "agent-2": ["172.18.0.9", "172.19.0.2"],
    });
    const directory = createReplicaDirectory({ replicas: [AGENT_1, AGENT_2], resolver });
    expect(await directory.identify("172.18.0.9")).toBe(null);
    expect(await directory.identify("172.18.0.2")).toBe("agent-1");
    expect(await directory.identify("172.19.0.2")).toBe("agent-2");
  });

  it("does not identify a replica whose lookup rejects, and does not reject", async () => {
    const { resolver } = fakeResolver({
      "agent-1": new Error("getaddrinfo ENOTFOUND agent-1"),
      "agent-2": ["172.19.0.2"],
    });
    const directory = createReplicaDirectory({ replicas: [AGENT_1, AGENT_2], resolver });
    expect(await directory.identify("172.19.0.2")).toBe("agent-2");
    await expect(directory.identify("172.18.0.2")).resolves.toBe(null);
  });

  it("resolves the host of an IP literal gatewayUrl and of an IPv6 one", async () => {
    const { resolver, calls } = fakeResolver({
      "127.0.0.1": ["127.0.0.1"],
      "::1": ["::1"],
    });
    const directory = createReplicaDirectory({
      replicas: [
        { name: "agent-1", gatewayUrl: "http://127.0.0.1:8090" },
        { name: "agent-2", gatewayUrl: "http://[::1]:8090" },
      ],
      resolver,
    });
    expect(await directory.identify("127.0.0.1")).toBe("agent-1");
    expect(await directory.identify("::1")).toBe("agent-2");
    expect([...calls].sort()).toEqual(["127.0.0.1", "::1"]);
  });
});

describe("fetchReplicaSummaries", () => {
  const SESSION = { id: "s1", status: "idle", repo: "demo" };

  /** Fake fetch that answers each URL with the given handler. */
  function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): {
    fetch: typeof globalThis.fetch;
    requests: { url: string; init?: RequestInit }[];
  } {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      return handler(url, init);
    };
    return { fetch: fetch as typeof globalThis.fetch, requests };
  }

  it("returns the session of a reachable replica with a session", async () => {
    const { fetch } = fakeFetch(async () => Response.json(SESSION, { status: 200 }));
    const result = await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: true, session: SESSION }],
    });
  });

  it("reports a reachable replica without session on 404", async () => {
    const { fetch } = fakeFetch(async () => new Response("not found", { status: 404 }));
    const result = await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: true, session: null }],
    });
  });

  it("reports an unreachable replica on 500", async () => {
    const { fetch } = fakeFetch(async () => new Response("boom", { status: 500 }));
    const result = await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: false, session: null }],
    });
  });

  it("reports an unreachable replica when the 200 body is not JSON", async () => {
    const { fetch } = fakeFetch(async () => new Response("<html>", { status: 200 }));
    const result = await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: false, session: null }],
    });
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
  ])("reports an unreachable replica when the 200 body is %s", async (_label, text) => {
    const { fetch } = fakeFetch(
      async () =>
        new Response(text, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: false, session: null }],
    });
  });

  it("reports an unreachable replica when fetch rejects", async () => {
    const { fetch } = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: false, session: null }],
    });
  });

  it("reports an unreachable replica when it does not answer in time", async () => {
    const { fetch } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const result = await fetchReplicaSummaries([AGENT_1], { fetch, timeoutMs: 50 });
    expect(result).toEqual({
      replicas: [{ name: "agent-1", reachable: false, session: null }],
    });
  });

  it("keeps the order of the replicas when answers arrive in another order", async () => {
    const { fetch } = fakeFetch(async (url) => {
      if (url.startsWith("http://agent-1:")) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json(SESSION, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const result = await fetchReplicaSummaries([AGENT_1, AGENT_2], { fetch });
    expect(result.replicas.map((replica) => replica.name)).toEqual(["agent-1", "agent-2"]);
    expect(result.replicas[0]).toEqual({ name: "agent-1", reachable: true, session: SESSION });
    expect(result.replicas[1]).toEqual({ name: "agent-2", reachable: true, session: null });
  });

  it("requests GET <gatewayUrl>/session with an accept header", async () => {
    const { fetch, requests } = fakeFetch(async () => new Response("", { status: 404 }));
    await fetchReplicaSummaries([AGENT_1], { fetch });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://agent-1:8090/session");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(new Headers(requests[0]?.init?.headers).get("accept")).toBe("application/json");
  });
});
