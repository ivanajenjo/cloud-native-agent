import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createFileNetworkLog } from "./egress/log.js";
import { createAuditPolicy } from "./egress/policy.js";
import { createEgressProxy } from "./egress/proxy.js";
import { createIngressApp } from "./ingress.js";

interface PackageJson {
  version: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// The token now lives only in memory. edge starts no child processes, but this way it is
// never inherited by anything that might run later.
delete process.env.AGENT_API_TOKEN;

const { token, gatewayUrl, dataDir, apiPort, proxyPort } = config;

const apiServer = serve(
  {
    fetch: createIngressApp({ token, gatewayUrl, version: packageJson.version }).fetch,
    port: apiPort,
    hostname: "0.0.0.0",
  },
  () => {
    console.log(`edge api listening on 0.0.0.0:${apiPort} -> ${gatewayUrl}`);
  },
);

const log = createFileNetworkLog(join(dataDir, "network.jsonl"));
const proxyServer: Server = createEgressProxy({ policy: createAuditPolicy(), log });

// CONNECT tunnels are not closed by server.close(), so keep the client sockets to destroy them.
const proxySockets = new Set<Socket>();
proxyServer.on("connection", (socket: Socket) => {
  proxySockets.add(socket);
  socket.on("close", () => {
    proxySockets.delete(socket);
  });
});

proxyServer.listen(proxyPort, "0.0.0.0", () => {
  console.log(`edge proxy listening on 0.0.0.0:${proxyPort} (mode: audit, phase 0)`);
});

function closeServer(server: {
  close(callback?: (error?: Error) => void): unknown;
}): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  // Drop idle keep-alive sockets so close() does not wait for their timeout.
  if ("closeIdleConnections" in apiServer) {
    apiServer.closeIdleConnections();
  }
  if ("closeIdleConnections" in proxyServer) {
    proxyServer.closeIdleConnections();
  }
  for (const socket of proxySockets) {
    socket.destroy();
  }

  await Promise.all([closeServer(apiServer), closeServer(proxyServer)]);
  await log.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
