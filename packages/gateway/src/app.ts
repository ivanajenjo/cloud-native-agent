import type { HealthResponse } from "@cna/shared";
import { Hono } from "hono";

export interface AppOptions {
  version: string;
}

/** Builds the gateway HTTP application. Does not open any port. */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      service: "gateway",
      version: options.version,
    };
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
