import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkLogEntry } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyStore } from "../src/egress/policy-store.js";
import { createRecentNetworkLog } from "../src/egress/recent-log.js";
import { createNetworkApi, formatEndpoint } from "../src/network-api.js";

const BASE = ["github.com", "pypi.org"];
const SERVICES = ["ntfy.lan:8081", "[fd00::5]:8080"];
const PORTS = [80, 443];

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cna-network-api-"));
  path = join(dir, "policy.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function entry(host: string): NetworkLogEntry {
  return {
    ts: "2026-11-16T10:00:00.000Z",
    method: "CONNECT",
    host,
    port: 443,
    decision: "allow",
    reason: "allowlist",
    bytesOut: 1,
    bytesIn: 2,
    durationMs: 3,
  };
}

async function setup() {
  const store = await PolicyStore.load(path);
  const recentLog = createRecentNetworkLog(1000);
  const app = createNetworkApi({
    store,
    base: BASE,
    services: SERVICES,
    allowedPorts: PORTS,
    recentLog,
  });
  return { app, store, recentLog };
}

const FULL_POLICY = {
  mode: "ask",
  allow: [],
  base: BASE,
  services: SERVICES,
  allowedPorts: PORTS,
};

async function putPolicy(
  app: Awaited<ReturnType<typeof setup>>["app"],
  body: unknown,
): Promise<Response> {
  return app.request("/network/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /network/policy", () => {
  it("returns the full policy", async () => {
    const { app } = await setup();
    const res = await app.request("/network/policy");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FULL_POLICY);
  });

  it("reflects the mode and allow list stored on disk", async () => {
    const { app, store } = await setup();
    await store.setMode("allowlist");
    await store.setAllow(["Example.org.", "*.corp.test:8443"]);
    const res = await app.request("/network/policy");
    expect(await res.json()).toEqual({
      ...FULL_POLICY,
      mode: "allowlist",
      allow: ["example.org", "*.corp.test:8443"],
    });
  });
});

describe("PUT /network/policy", () => {
  it("changes only the mode", async () => {
    const { app, store } = await setup();
    await store.setAllow(["example.org"]);
    const res = await putPolicy(app, { mode: "audit" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...FULL_POLICY, mode: "audit", allow: ["example.org"] });
    expect(store.get()).toEqual({ mode: "audit", allow: ["example.org"] });
  });

  it("replaces only the allow list, canonicalized and deduplicated", async () => {
    const { app, store } = await setup();
    await store.setMode("allowlist");
    const res = await putPolicy(app, { allow: ["GitHub.com.", "github.com", "*.Example.com:443"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...FULL_POLICY,
      mode: "allowlist",
      allow: ["github.com", "*.example.com:443"],
    });
    const reloaded = await PolicyStore.load(path);
    expect(reloaded.get()).toEqual({
      mode: "allowlist",
      allow: ["github.com", "*.example.com:443"],
    });
  });

  it("changes mode and allow list together", async () => {
    const { app } = await setup();
    const res = await putPolicy(app, { mode: "allowlist", allow: ["pypi.org:8080"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...FULL_POLICY,
      mode: "allowlist",
      allow: ["pypi.org:8080"],
    });
  });

  it("an empty object is rejected with 400 and nothing changes", async () => {
    const { app, store } = await setup();
    const res = await putPolicy(app, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(store.get()).toEqual({ mode: "ask", allow: [] });
  });

  it("an invalid entry is rejected with 400 naming its index, and the policy does not change", async () => {
    const { app, store } = await setup();
    await store.setAllow(["example.org"]);
    const res = await putPolicy(app, { mode: "audit", allow: ["http://x", "github.com"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("allow.0");
    expect(store.get()).toEqual({ mode: "ask", allow: ["example.org"] });
    expect((await PolicyStore.load(path)).get()).toEqual({
      mode: "ask",
      allow: ["example.org"],
    });
  });

  it("an unknown mode is rejected with 400", async () => {
    const { app, store } = await setup();
    const res = await putPolicy(app, { mode: "open" });
    expect(res.status).toBe(400);
    expect(store.get().mode).toBe("ask");
  });

  it("unknown fields are rejected with 400", async () => {
    const { app } = await setup();
    const res = await putPolicy(app, { mode: "audit", base: ["evil.example"] });
    expect(res.status).toBe(400);
  });

  it("a body over 64 KiB is rejected with 413", async () => {
    const { app, store } = await setup();
    const res = await putPolicy(app, { allow: ["a".repeat(70 * 1024)] });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "invalid_request", message: "body too large" });
    expect(store.get()).toEqual({ mode: "ask", allow: [] });
  });

  it("invalid JSON is rejected with 400", async () => {
    const { app } = await setup();
    const res = await putPolicy(app, '{"mode":');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("a failure to persist gives 500 internal_error and logs only the message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, store } = await setup();
    // A directory at the temporary path makes the write fail.
    await mkdir(`${path}.tmp`);
    const res = await putPolicy(app, { mode: "audit" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(store.get().mode).toBe("ask");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /network/log", () => {
  async function withEntries(count: number) {
    const setupResult = await setup();
    for (let n = 1; n <= count; n++) {
      setupResult.recentLog.append(entry(`host-${n}.example`));
    }
    return setupResult;
  }

  it("without limit returns up to 200 entries, oldest first", async () => {
    const { app } = await withEntries(250);
    const res = await app.request("/network/log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: NetworkLogEntry[] };
    expect(body.entries).toHaveLength(200);
    expect(body.entries[0]?.host).toBe("host-51.example");
    expect(body.entries[199]?.host).toBe("host-250.example");
  });

  it("returns the last `limit` entries", async () => {
    const { app } = await withEntries(5);
    const res = await app.request("/network/log?limit=2");
    expect(await res.json()).toEqual({
      entries: [entry("host-4.example"), entry("host-5.example")],
    });
  });

  it("accepts the maximum limit of 1000", async () => {
    const { app } = await withEntries(3);
    const res = await app.request("/network/log?limit=1000");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it.each(["0", "1001", "abc", "-1", "1.5", "", "99999999999999999999"])(
    "limit=%s is rejected with 400",
    async (limit) => {
      const { app } = await withEntries(1);
      const res = await app.request(`/network/log?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    },
  );
});

describe("routing", () => {
  it("POST /network/policy is 405", async () => {
    const { app } = await setup();
    const res = await app.request("/network/policy", { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "invalid_request", message: "method not allowed" });
  });

  it("POST /network/log is 405", async () => {
    const { app } = await setup();
    const res = await app.request("/network/log", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("GET /network/otra is 404", async () => {
    const { app } = await setup();
    const res = await app.request("/network/otra");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("a trailing slash is not a known route", async () => {
    const { app } = await setup();
    expect((await app.request("/network/policy/")).status).toBe(404);
  });
});

describe("formatEndpoint", () => {
  it("formats IPv4 and names as host:port", () => {
    expect(formatEndpoint("192.168.1.50", 11434)).toBe("192.168.1.50:11434");
    expect(formatEndpoint("ntfy.lan", 8081)).toBe("ntfy.lan:8081");
  });

  it("brackets IPv6 literals", () => {
    expect(formatEndpoint("::1", 8080)).toBe("[::1]:8080");
    expect(formatEndpoint("fd00::5", 443)).toBe("[fd00::5]:443");
  });
});
