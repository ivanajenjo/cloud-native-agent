import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { type GatewayConfig, loadGatewayConfig } from "./config.js";
import { createGatewayRuntime, type GatewayRuntime } from "./wiring.js";

interface PackageJson {
  version: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

let config: GatewayConfig;
try {
  config = loadGatewayConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// The API token belongs to edge only. Removed before the runtime starts anything.
delete process.env.AGENT_API_TOKEN;

let runtime: GatewayRuntime;
try {
  runtime = await createGatewayRuntime({
    config,
    version: packageJson.version,
    env: process.env,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const { port } = config;

const server = serve({ fetch: runtime.app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`gateway listening on 0.0.0.0:${port}`);
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  // Drop idle keep-alive sockets so close() does not wait for their timeout.
  if ("closeIdleConnections" in server) {
    server.closeIdleConnections();
  }
  await runtime.close();
  server.close(() => {
    process.exit(0);
  });
  // Open SSE streams (GET /session/events) never end by themselves: cut them so close() finishes.
  if ("closeAllConnections" in server) {
    server.closeAllConnections();
  }
}

process.on("SIGTERM", () => {
  shutdown().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "shutdown failed");
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "shutdown failed");
    process.exit(1);
  });
});
