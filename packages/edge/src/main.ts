import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createEdgeRuntime, type EdgeRuntime } from "./wiring.js";

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

const { apiPort, proxyPort, replicas } = config;

let runtime: EdgeRuntime;
try {
  runtime = await createEdgeRuntime({ config, version: packageJson.version });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const apiServer = serve(
  {
    fetch: runtime.ingress.fetch,
    port: apiPort,
    hostname: "0.0.0.0",
  },
  () => {
    const names = replicas.map((replica) => replica.name).join(", ");
    console.log(`edge api listening on 0.0.0.0:${apiPort} -> replicas: ${names}`);
  },
);

const proxyServer: Server = runtime.proxy;

// CONNECT tunnels are not closed by server.close(), so keep the client sockets to destroy them.
const proxySockets = new Set<Socket>();
proxyServer.on("connection", (socket: Socket) => {
  proxySockets.add(socket);
  socket.on("close", () => {
    proxySockets.delete(socket);
  });
});

proxyServer.listen(proxyPort, "0.0.0.0", () => {
  console.log(`edge proxy listening on 0.0.0.0:${proxyPort} (mode: ${runtime.mode()})`);
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
  await runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
