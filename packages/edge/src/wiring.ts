import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import {
  NETWORK_LOG_CAPACITY,
  type NetworkLogEntry,
  type ProviderEndpoint,
  parseNotificationsConfig,
  parseProvidersConfig,
  parseWebConfig,
  providerEndpoints,
  type ServiceEndpoint,
  serviceEndpoints,
} from "@cna/shared";
import type { Hono } from "hono";
import type { EdgeConfig } from "./config.js";
import { BASE_ALLOWLIST, formatAllowlistEntry, parseAllowlistEntry } from "./egress/allowlist.js";
import { AskCoordinator } from "./egress/ask.js";
import { createFileNetworkLog, type NetworkLog } from "./egress/log.js";
import {
  createNetworkPolicy,
  DEFAULT_ALLOWED_PORTS,
  type Resolver,
  systemResolver,
} from "./egress/policy.js";
import { PolicyStore } from "./egress/policy-store.js";
import { createEgressProxy } from "./egress/proxy.js";
import { createRecentNetworkLog } from "./egress/recent-log.js";
import { createReplicaGateways } from "./gateway-client.js";
import { createIngressApp } from "./ingress.js";
import { createNetworkApi, formatEndpoint } from "./network-api.js";
import { createReplicaDirectory, fetchReplicaSummaries } from "./replicas.js";

export interface EdgeRuntime {
  ingress: Hono;
  proxy: Server;
  /** Endpoints of providers.yaml (read-only). */
  providers: readonly ProviderEndpoint[];
  /** Endpoints of notifications.yaml and web.yaml (read-only). */
  services: readonly ServiceEndpoint[];
  /** Cancels pending network questions and closes the network log. */
  close(): Promise<void>;
  /** Current mode, for the startup log line. */
  mode(): string;
}

export interface WiringOptions {
  config: EdgeConfig;
  version: string;
  /** Injectable for tests. Default globalThis.fetch (used by the ingress and the gateway clients). */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. Default systemResolver. */
  resolver?: Resolver;
  /** Default console.error. Receives only messages without secrets. */
  logError?: (message: string) => void;
  /** Injectable for tests. Opens the upstream TCP connection to an already validated IP. Default net.connect. */
  connect?: (target: { host: string; port: number }) => Socket;
}

/**
 * Builds edge's runtime: policy, ask coordinator, one gateway client per replica (ADR-0012),
 * network log, egress proxy and ingress. Throws (startup must fail) if the policy file,
 * providers.yaml, notifications.yaml or web.yaml cannot be read or parsed.
 */
export async function createEdgeRuntime(options: WiringOptions): Promise<EdgeRuntime> {
  const { config, version } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const resolver = options.resolver ?? systemResolver;
  const logError = options.logError ?? ((message: string) => console.error(message));

  const store = await PolicyStore.load(join(config.dataDir, "policy.json"));
  const providers = await loadProviderEndpoints(config.providersFile);
  const services = await loadServiceEndpoints({
    notificationsFile: config.notificationsFile,
    webFile: config.webFile,
  });

  const gateways = createReplicaGateways({ replicas: config.replicas, fetch });
  const directory = createReplicaDirectory({ replicas: config.replicas, resolver });
  const ask = new AskCoordinator({ gateway: gateways, timeoutMs: config.askTimeoutMs });
  const policy = createNetworkPolicy({
    store,
    baseAllowlist: BASE_ALLOWLIST.map(parseAllowlistEntry),
    providers,
    services,
    ask,
    onPersistError: (error) =>
      logError(
        `edge: could not persist allow-always entry: ${error instanceof Error ? error.message : "unknown error"}`,
      ),
  });

  // Each entry goes to the SSE stream of the replica that opened the connection (fire and
  // forget), to the recent buffer served by GET /network/log, and to network.jsonl (edge's
  // volume). An entry without replica (unknown client, ADR-0012) reaches no gateway.
  const fileLog = createFileNetworkLog(join(config.dataDir, "network.jsonl"));
  const recentLog = createRecentNetworkLog(NETWORK_LOG_CAPACITY);
  const log: NetworkLog = {
    append(entry: NetworkLogEntry) {
      if (entry.replica !== undefined) {
        void gateways.publishNetworkEntry(entry.replica, entry);
      }
      recentLog.append(entry);
      return fileLog.append(entry);
    },
    close() {
      return fileLog.close();
    },
  };

  const proxy = createEgressProxy({
    policy,
    log,
    resolver,
    connect: options.connect,
    identify: (address) => directory.identify(address),
  });
  const networkApi = createNetworkApi({
    store,
    base: BASE_ALLOWLIST.map((text) => formatAllowlistEntry(parseAllowlistEntry(text))),
    services: [...new Set([...providers, ...services].map((e) => formatEndpoint(e.host, e.port)))],
    allowedPorts: DEFAULT_ALLOWED_PORTS,
    recentLog,
  });
  const ingress = createIngressApp({
    token: config.token,
    replicas: config.replicas,
    version,
    fetch,
    networkAnswers: ask,
    networkApi,
    listReplicas: () => fetchReplicaSummaries(config.replicas, { fetch }),
  });

  return {
    ingress,
    proxy,
    providers,
    services,
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

/**
 * Reads notifications.yaml and web.yaml and returns the service endpoints edge must allow. A
 * missing file means that service is disabled and contributes nothing. Parse and validation
 * errors propagate: edge must not start with a configuration it does not understand.
 */
export async function loadServiceEndpoints(paths: {
  notificationsFile: string;
  webFile: string;
}): Promise<ServiceEndpoint[]> {
  const notifications = await readOptionalFile(paths.notificationsFile);
  const web = await readOptionalFile(paths.webFile);
  return serviceEndpoints({
    notifications:
      notifications === undefined ? undefined : parseNotificationsConfig(notifications),
    web: web === undefined ? undefined : parseWebConfig(web),
  });
}

/** File contents, or undefined when the file does not exist. */
async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
