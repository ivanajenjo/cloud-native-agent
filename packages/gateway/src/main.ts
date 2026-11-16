import { readFileSync } from "node:fs";
import { DEFAULT_PORTS, parsePort } from "@cna/shared";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

interface PackageJson {
  version: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

let port: number;
try {
  port = parsePort(process.env.GATEWAY_PORT, DEFAULT_PORTS.gateway);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = createApp({ version: packageJson.version });

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`gateway listening on 0.0.0.0:${port}`);
});

function shutdown(): void {
  server.close(() => {
    process.exit(0);
  });
  // Drop idle keep-alive sockets so close() does not wait for their timeout.
  if ("closeIdleConnections" in server) {
    server.closeIdleConnections();
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
