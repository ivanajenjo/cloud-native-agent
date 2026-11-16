import {
  NETWORK_LOG_CAPACITY,
  NETWORK_LOG_DEFAULT_LIMIT,
  type NetworkLogResponse,
  type NetworkPolicyResponse,
  UpdateNetworkPolicyRequestSchema,
} from "@cna/shared";
import { type Context, Hono } from "hono";
import { parseAllowlistEntry } from "./egress/allowlist.js";
import type { PolicyStore } from "./egress/policy-store.js";
import type { RecentNetworkLog } from "./egress/recent-log.js";
import { readLimitedText } from "./ingress.js";

export interface NetworkApiOptions {
  store: Pick<PolicyStore, "get" | "setMode" | "setAllow">;
  /** BASE_ALLOWLIST as canonical strings. */
  base: readonly string[];
  /** host:port of providers and services, already formatted (IPv6 as [addr]:port). */
  services: readonly string[];
  allowedPorts: readonly number[];
  recentLog: Pick<RecentNetworkLog, "list">;
}

/** Largest accepted body of `PUT /network/policy`. */
const MAX_POLICY_BODY_BYTES = 64 * 1024;

/** Decimal digits only: `?limit=` is validated against NETWORK_LOG_CAPACITY after parsing. */
const LIMIT_PATTERN = /^[0-9]+$/;

/** `host:port`, or `[addr]:port` for IPv6 literals. */
export function formatEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function apiError(
  c: Context,
  status: 400 | 404 | 405 | 413,
  error: "invalid_request" | "not_found",
  message?: string,
): Response {
  return message === undefined ? c.json({ error }, status) : c.json({ error, message }, status);
}

/**
 * Router for `/network/*`, mounted by ingress after the Bearer check. Paths are the effective
 * ones (dot segments and percent-encoding already resolved). Exact paths, no trailing slash.
 */
export function createNetworkApi(options: NetworkApiOptions): Hono {
  const { store, recentLog } = options;
  const app = new Hono();

  const policyResponse = (): NetworkPolicyResponse => {
    const policy = store.get();
    return {
      mode: policy.mode,
      allow: policy.allow,
      base: [...options.base],
      services: [...options.services],
      allowedPorts: [...options.allowedPorts],
    };
  };

  const methodNotAllowed = (c: Context): Response =>
    apiError(c, 405, "invalid_request", "method not allowed");

  async function updatePolicy(c: Context): Promise<Response> {
    const text = await readLimitedText(c.req.raw.body, MAX_POLICY_BODY_BYTES);
    if (text === null) {
      return apiError(c, 413, "invalid_request", "body too large");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return apiError(c, 400, "invalid_request", "invalid JSON");
    }
    const parsed = UpdateNetworkPolicyRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid body");
    }

    const body = parsed.data;
    // Validate every entry before saving anything, so a bad entry leaves the policy unchanged.
    for (const [index, entry] of (body.allow ?? []).entries()) {
      try {
        parseAllowlistEntry(entry);
      } catch {
        return apiError(c, 400, "invalid_request", `allow.${index}: invalid entry`);
      }
    }

    try {
      if (body.allow !== undefined) {
        await store.setAllow(body.allow);
      }
      if (body.mode !== undefined) {
        await store.setMode(body.mode);
      }
    } catch (error) {
      // Log only the message: the entries may be sensitive.
      console.error(
        "edge: could not update network policy:",
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: "internal_error" as const }, 500);
    }
    return c.json(policyResponse());
  }

  app.all("/network/policy", (c) => {
    switch (c.req.method) {
      case "GET":
        return c.json(policyResponse());
      case "PUT":
        return updatePolicy(c);
      default:
        return methodNotAllowed(c);
    }
  });

  app.all("/network/log", (c) => {
    if (c.req.method !== "GET") {
      return methodNotAllowed(c);
    }
    const raw = c.req.query("limit");
    let limit = NETWORK_LOG_DEFAULT_LIMIT;
    if (raw !== undefined) {
      const value = LIMIT_PATTERN.test(raw) ? Number(raw) : Number.NaN;
      if (!(value >= 1 && value <= NETWORK_LOG_CAPACITY)) {
        return apiError(c, 400, "invalid_request", `limit must be 1..${NETWORK_LOG_CAPACITY}`);
      }
      limit = value;
    }
    const body: NetworkLogResponse = { entries: recentLog.list(limit) };
    return c.json(body);
  });

  app.notFound((c) => apiError(c, 404, "not_found"));

  return app;
}
