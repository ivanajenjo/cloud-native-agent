import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_IMMUTABLE,
  CACHE_NO_CACHE,
  CONTENT_SECURITY_POLICY,
  mountWebUi,
} from "../src/web-ui.js";

const SECRET = "top-secret-outside-web-root";
const INDEX_HTML = "<!doctype html><title>cna ui</title>";

/** Test app with the same JSON 404 as createApp. */
function buildApp(rootDir: string): Hono {
  const app = new Hono();
  mountWebUi(app, rootDir);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

let base: string;
let dist: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cna-web-ui-"));
  dist = join(base, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), INDEX_HTML);
  await writeFile(join(dist, "assets", "app-abc.js"), "console.log('app');");
  // Lives next to dist/, so it is outside the web root.
  await writeFile(join(base, "secret.txt"), SECRET);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("mountWebUi", () => {
  it("redirects / and /ui to /ui/", async () => {
    const app = buildApp(dist);

    for (const path of ["/", "/ui"]) {
      const res = await app.request(path);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/ui/");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it("serves index.html at /ui/ with the security headers", async () => {
    const app = buildApp(dist);

    const res = await app.request("/ui/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe(CACHE_NO_CACHE);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves hashed assets as immutable", async () => {
    const app = buildApp(dist);

    const res = await app.request("/ui/assets/app-abc.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(CACHE_IMMUTABLE);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("console.log('app');");
  });

  it("answers HEAD /ui/ with the same headers and no body", async () => {
    const app = buildApp(dist);

    const get = await app.request("/ui/");
    const head = await app.request("/ui/", { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const name of [
      "content-type",
      "content-security-policy",
      "x-content-type-options",
      "referrer-policy",
      "x-frame-options",
      "cache-control",
    ]) {
      expect(head.headers.get(name)).toBe(get.headers.get(name));
    }
  });

  it("rejects unsafe paths with 404 and never leaks the secret", async () => {
    const app = buildApp(dist);
    const paths = [
      "/ui/../secret.txt",
      "/ui/%2e%2e/secret.txt",
      "/ui/assets/%2e%2e/%2e%2e/secret.txt",
      "/ui/..%2fsecret.txt",
      "/ui/a%5c..%5csecret.txt",
      "/ui/%00",
      "/ui/%E0%A4%A",
      "/ui/assets",
      "/ui/nope.js",
    ];

    for (const path of paths) {
      const res = await app.request(path);
      const text = await res.text();
      expect(res.status, path).toBe(404);
      expect(text, path).not.toContain(SECRET);
      expect(text, path).toBe('{"error":"not_found"}');
    }
  });

  it("rejects hidden files inside the web root", async () => {
    await writeFile(join(dist, ".env"), "TOKEN=hidden");
    const app = buildApp(dist);

    const res = await app.request("/ui/.env");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOKEN=hidden");
  });

  it("rejects a symlink inside the web root that points outside", async () => {
    await symlink(join(base, "secret.txt"), join(dist, "link.txt"));
    const app = buildApp(dist);

    const res = await app.request("/ui/link.txt");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("answers 404 for every /ui/ path when the web root does not exist", async () => {
    const app = buildApp(join(base, "missing"));

    const res = await app.request("/ui/");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect((await app.request("/ui/assets/app-abc.js")).status).toBe(404);
  });

  it("sets the content-type by extension", async () => {
    await writeFile(join(dist, "style.css"), "body{}");
    await writeFile(join(dist, "logo.svg"), "<svg/>");
    await writeFile(join(dist, "app.js.map"), "{}");
    await writeFile(join(dist, "data.bin"), "xyz");
    const app = buildApp(dist);

    const expected: Array<[string, string]> = [
      ["/ui/style.css", "text/css; charset=utf-8"],
      ["/ui/logo.svg", "image/svg+xml"],
      ["/ui/app.js.map", "application/json; charset=utf-8"],
      ["/ui/data.bin", "application/octet-stream"],
    ];
    for (const [path, type] of expected) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
    }
  });
});
