import { z } from "zod";
import { NETWORK_MODES, type NetworkLogEntry, type NetworkMode } from "./network.js";

/** `/network/*` endpoints, answered by edge itself (never forwarded to the gateway). */

export const NETWORK_ROUTES = {
  log: "/network/log",
  policy: "/network/policy",
} as const;

/** Body of `GET /network/policy`. */
export interface NetworkPolicyResponse {
  mode: NetworkMode;
  /** Entries added by the user ("allow always" or PUT), canonical `host[:port]`. Editable. */
  allow: string[];
  /** Fixed base allowlist of edge. Not editable. */
  base: string[];
  /** `host:port` of configured services: providers, notifications, web search. Not editable. */
  services: string[];
  /** Ports allowed outside the lists (80 and 443). */
  allowedPorts: number[];
}

/**
 * Body of `PUT /network/policy`. At least one field. `allow` replaces the whole user list;
 * each entry is validated like an allowlist entry (`host[:port]`, `*.` prefix only).
 */
export const UpdateNetworkPolicyRequestSchema = z
  .object({
    mode: z.enum(NETWORK_MODES).optional(),
    allow: z.array(z.string().min(1).max(260)).max(500).optional(),
  })
  .strict()
  .refine((body) => body.mode !== undefined || body.allow !== undefined, {
    message: "expected mode or allow",
  });
export type UpdateNetworkPolicyRequest = z.infer<typeof UpdateNetworkPolicyRequestSchema>;

/** Body of `GET /network/log`: most recent entries since edge started, oldest first. */
export interface NetworkLogResponse {
  entries: NetworkLogEntry[];
}

/** Entries kept in memory for `GET /network/log`, and the default/maximum of `?limit=`. */
export const NETWORK_LOG_CAPACITY = 1000;
export const NETWORK_LOG_DEFAULT_LIMIT = 200;
