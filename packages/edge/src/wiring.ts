import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import {
  type NetworkLogEntry,
  type ProviderEndpoint,
  parseProvidersConfig,
  providerEndpoints,
} from "@cna/shared";
import type { Hono } from "hono";
import type { EdgeConfig } from "./config.js";
import { BASE_ALLOWLIST, parseAllowlistEntry } from "./egress/allowlist.js";
import { AskCoordinator } from "./egress/ask.js";
import { createFileNetworkLog, type NetworkLog } from "./egress/log.js";
import { createNetworkPolicy, type Resolver, systemResolver } from "./egress/policy.js";
import { PolicyStore } from "./egress/policy-store.js";
import { createEgressProxy } from "./egress/proxy.js";
import { createGatewayClient } from "./gateway-client.js";
import { createIngressApp } from "./ingress.js";

export interface EdgeRuntime {
  ingress: Hono;
  proxy: Server;
  /** Cancels pending network questions and closes the network log. */
  close(): Promise<void>;
  /** Current mode, for the startup log line. */
  mode(): string;
}

export interface WiringOptions {
  config: EdgeConfig;
  version: string;
  /** Injectable for tests. Default globalThis.fetch (used by the ingress and the gateway client). */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. Default systemResolver. */
  resolver?: Resolver;
  /** Default console.error. Receives only messages without secrets. */
  logError?: (message: string) => void;
  /** Injectable for tests. Opens the upstream TCP connection to an already validated IP. Default net.connect. */
  connect?: (target: { host: string; port: number }) => Socket;
}

/**
 * Builds edge's runtime: policy, ask coordinator, gateway client, network log, egress proxy and
 * ingress. Throws (startup must fail) if the policy file or providers.yaml cannot be read or parsed.
 */
export async function createEdgeRuntime(options: WiringOptions): Promise<EdgeRuntime> {
  const { config, version } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const resolver = options.resolver ?? systemResolver;
  const logError = options.logError ?? ((message: string) => console.error(message));

  const store = await PolicyStore.load(join(config.dataDir, "policy.json"));
  const providers = await loadProviderEndpoints(config.providersFile);

  const gateway = createGatewayClient({ gatewayUrl: config.gatewayUrl, fetch });
  const ask = new AskCoordinator({ gateway, timeoutMs: config.askTimeoutMs });
  const policy = createNetworkPolicy({
    store,
    baseAllowlist: BASE_ALLOWLIST.map(parseAllowlistEntry),
    providers,
    ask,
    onPersistError: (error) =>
      logError(
        `edge: could not persist allow-always entry: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
  });

  // Each entry goes to the SSE stream (fire and forget) and to network.jsonl (edge's volume).
  const fileLog = createFileNetworkLog(join(config.dataDir, "network.jsonl"));
  const log: NetworkLog = {
    append(entry: NetworkLogEntry) {
      void gateway.publishNetworkEntry(entry);
      return fileLog.append(entry);
    },
    close() {
      return fileLog.close();
    },
  };

  const proxy = createEgressProxy({ policy, log, resolver, connect: options.connect });
  const ingress = createIngressApp({
    token: config.token,
    gatewayUrl: config.gatewayUrl,
    version,
    fetch,
    networkAnswers: ask,
  });

  return {
    ingress,
    proxy,
    async close() {
      ask.cancelAll();
      await log.close();
    },
    mode() {
      return store.get().mode;
    },
  };
}

/**
 * Reads providers.yaml and returns the endpoints edge must allow. A missing file means no
 * providers. Parse and validation errors propagate.
 */
export async function loadProviderEndpoints(path: string): Promise<ProviderEndpoint[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  return providerEndpoints(parseProvidersConfig(text));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
