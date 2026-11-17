import { isIP } from "node:net";
import type { ReplicaSummary, ReplicasResponse, SessionInfo } from "@cna/shared";
import type { Resolver } from "./egress/policy.js";

/** One agent replica behind edge (ADR-0012). */
export interface ReplicaTarget {
  /** Replica name (REPLICA_NAME_PATTERN), e.g. "agent-1". */
  name: string;
  /** Its gateway, normalized origin without trailing slash, e.g. "http://agent-1:8090". */
  gatewayUrl: string;
}

export interface ReplicaDirectoryOptions {
  /** Non-empty, names unique. The host of each gatewayUrl is what gets resolved. */
  replicas: readonly ReplicaTarget[];
  /** Resolves a gateway host to its addresses ([] on failure). IP literals resolve to themselves. */
  resolver: Resolver;
  /** Minimum time between two refreshes triggered by unknown addresses. Default 1000 ms. */
  minRefreshIntervalMs?: number;
  /** Clock in ms. Default Date.now. */
  now?: () => number;
}

export interface ReplicaDirectory {
  /**
   * Name of the replica whose gateway host resolves to `address` (the remote address of a
   * connection to the egress proxy), or null when it is not a replica. Never rejects.
   */
  identify(address: string): Promise<string | null>;
}

const IPV4_MAPPED_PREFIX = "::ffff:";

/** Host of a gateway URL, without the brackets of an IPv6 literal (`[::1]` → `::1`). */
function gatewayHost(gatewayUrl: string): string {
  const hostname = new URL(gatewayUrl).hostname;
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function createReplicaDirectory(options: ReplicaDirectoryOptions): ReplicaDirectory {
  const { replicas, resolver, minRefreshIntervalMs = 1000, now = Date.now } = options;
  const hosts = replicas.map((replica) => ({
    name: replica.name,
    host: gatewayHost(replica.gatewayUrl),
  }));

  /** Normalized address → replica name, or null when two replicas share the address. */
  let cache = new Map<string, string | null>();
  let lastRefreshStart: number | undefined;
  let refreshing: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    lastRefreshStart = now();
    const resolved = await Promise.all(
      hosts.map(async ({ name, host }) => {
        try {
          const addresses = await resolver(host);
          return { name, addresses: Array.isArray(addresses) ? addresses : [] };
        } catch {
          return { name, addresses: [] as string[] };
        }
      }),
    );
    // A new map replaces the old one entirely, so IPs of restarted containers are forgotten.
    const next = new Map<string, string | null>();
    for (const { name, addresses } of resolved) {
      for (const raw of addresses) {
        if (typeof raw !== "string") {
          continue;
        }
        const address = normalizeAddress(raw);
        if (address === "") {
          continue;
        }
        if (!next.has(address)) {
          next.set(address, name);
        } else if (next.get(address) !== name) {
          next.set(address, null);
        }
      }
    }
    cache = next;
  }

  const canRefresh = (): boolean =>
    lastRefreshStart === undefined || now() - lastRefreshStart >= minRefreshIntervalMs;

  return {
    async identify(address: string): Promise<string | null> {
      try {
        const normalized = normalizeAddress(address);
        if (normalized === "") {
          return null;
        }
        if (cache.has(normalized)) {
          return cache.get(normalized) ?? null;
        }
        if (refreshing === null && canRefresh()) {
          refreshing = refresh().finally(() => {
            refreshing = null;
          });
        }
        if (refreshing !== null) {
          await refreshing;
        }
        return cache.get(normalized) ?? null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Canonical form of a socket address: lowercased, without an IPv6 zone (`%eth0`) and with
 * IPv4-mapped IPv6 (`::ffff:172.18.0.3`) turned into plain IPv4.
 */
export function normalizeAddress(address: string): string {
  let value = address.toLowerCase();
  const zoneStart = value.indexOf("%");
  if (zoneStart !== -1) {
    value = value.slice(0, zoneStart);
  }
  if (value.startsWith(IPV4_MAPPED_PREFIX)) {
    const embedded = value.slice(IPV4_MAPPED_PREFIX.length);
    if (isIP(embedded) === 4) {
      return embedded;
    }
  }
  return value;
}

export interface ReplicaSummariesOptions {
  /** Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per replica (AbortSignal.timeout). Default 2000 ms. */
  timeoutMs?: number;
}

/** Builds the body of `GET /replicas` asking each gateway for `GET /session`, in parallel. */
export async function fetchReplicaSummaries(
  replicas: readonly ReplicaTarget[],
  options: ReplicaSummariesOptions = {},
): Promise<ReplicasResponse> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const summaries = await Promise.all(
    replicas.map((replica) => fetchSummary(replica, fetchImpl, timeoutMs)),
  );
  return { replicas: summaries };
}

async function fetchSummary(
  replica: ReplicaTarget,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ReplicaSummary> {
  const unreachable: ReplicaSummary = { name: replica.name, reachable: false, session: null };
  let response: Response;
  try {
    response = await fetchImpl(`${replica.gatewayUrl}/session`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return unreachable;
  }
  try {
    if (response.status === 404) {
      await discardBody(response);
      return { name: replica.name, reachable: true, session: null };
    }
    if (response.status !== 200) {
      await discardBody(response);
      return unreachable;
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return unreachable;
    }
    return { name: replica.name, reachable: true, session: body as SessionInfo };
  } catch {
    return unreachable;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is not needed; a failed cancel changes nothing.
  }
}
