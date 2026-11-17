import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";

/** Content-Security-Policy of every static response under /ui/. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

/** Headers of every response of the web UI (static files, redirects and 404s). */
export const WEB_UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export const CACHE_NO_CACHE = "no-cache";
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

const UI_PREFIX = "/ui/";
const INDEX_FILE = "index.html";
const ASSETS_PREFIX = "assets/";
const FALLBACK_CONTENT_TYPE = "application/octet-stream";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Mounts GET/HEAD `/`, `/ui` and `/ui/*` on `app`, serving files from `rootDir`. Fails closed:
 * any path that is not a regular file inside `rootDir` answers 404. A missing `rootDir` (web UI
 * not built) only makes every /ui/* request 404; it never throws here.
 */
export function mountWebUi(app: Hono, rootDir: string): void {
  const root = resolve(rootDir);
  app.on(["GET", "HEAD"], "/", () => redirectToUi());
  app.on(["GET", "HEAD"], "/ui", () => redirectToUi());
  app.on(["GET", "HEAD"], "/ui/*", (c) => serveUi(c, root));
}

function redirectToUi(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      ...WEB_UI_SECURITY_HEADERS,
      location: "/ui/",
      "cache-control": CACHE_NO_CACHE,
    },
  });
}

async function serveUi(c: Context, root: string): Promise<Response> {
  const isHead = c.req.method === "HEAD";
  // The raw pathname: Hono's c.req.path is already partly decoded, and decoding twice is unsafe.
  const relative = uiRelativePath(new URL(c.req.url).pathname);
  if (relative === null) {
    return notFound(isHead);
  }
  const file = await locateFile(root, relative);
  if (file === null) {
    return notFound(isHead);
  }
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return notFound(isHead);
  }
  return new Response(isHead ? null : body, {
    status: 200,
    headers: {
      ...WEB_UI_SECURITY_HEADERS,
      "content-type": contentTypeOf(relative),
      "cache-control": cacheControlOf(relative),
      "content-length": String(body.byteLength),
    },
  });
}

/**
 * Returns the decoded path relative to the web root, or null if the request must be rejected.
 * `/ui/` maps to index.html.
 */
function uiRelativePath(pathname: string): string | null {
  if (!pathname.startsWith(UI_PREFIX)) {
    return null;
  }
  const raw = pathname.slice(UI_PREFIX.length);
  if (raw === "") {
    return INDEX_FILE;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\u0000")) {
    return null;
  }
  for (const segment of decoded.split("/")) {
    // Empty segments are rejected too (no absolute paths, no trailing slashes).
    // A leading dot covers "." and ".." and hidden files such as .env.
    if (segment === "" || segment.startsWith(".")) {
      return null;
    }
  }
  return decoded;
}

/** Resolves `relative` under `root` to its real path, or null if it is not a servable file. */
async function locateFile(root: string, relative: string): Promise<string | null> {
  const resolved = resolve(root, relative);
  if (!isInside(resolved, root)) {
    return null;
  }
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(resolved)]);
    if (!isInside(real, realRoot)) {
      return null;
    }
    const info = await stat(real);
    return info.isFile() ? real : null;
  } catch {
    return null;
  }
}

/** True if `target` is `dir` or lies below it. Both must be normalized absolute paths. */
function isInside(target: string, dir: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target === dir || target.startsWith(prefix);
}

function contentTypeOf(relative: string): string {
  return CONTENT_TYPES[extname(relative).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;
}

function cacheControlOf(relative: string): string {
  if (relative === INDEX_FILE) {
    return CACHE_NO_CACHE;
  }
  return relative.startsWith(ASSETS_PREFIX) ? CACHE_IMMUTABLE : CACHE_NO_CACHE;
}

function notFound(isHead: boolean): Response {
  return new Response(isHead ? null : JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: {
      ...WEB_UI_SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE_NO_CACHE,
    },
  });
}
