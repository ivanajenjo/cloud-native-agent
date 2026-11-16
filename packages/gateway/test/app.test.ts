import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

describe("GET /health", () => {
  it("returns the health body as JSON", async () => {
    const app = createApp({ version: "1.2.3" });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", service: "gateway", version: "1.2.3" });
  });
});

describe("unknown routes", () => {
  it("answers POST /health with 404 not_found", async () => {
    const app = createApp({ version: "1.2.3" });

    const res = await app.request("/health", { method: "POST" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers GET /nope with 404 not_found", async () => {
    const app = createApp({ version: "1.2.3" });

    const res = await app.request("/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("unhandled errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 500 internal_error without leaking the message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ version: "1.2.3" });
    app.get("/boom", () => {
      throw new Error("secret detail");
    });

    const res = await app.request("/boom");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("secret detail");
    expect(consoleError).toHaveBeenCalled();
  });
});
