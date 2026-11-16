import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const TOKEN = "0123456789abcdef".repeat(4);

/** Environment with a valid token and no other variables set. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { AGENT_API_TOKEN: TOKEN, ...extra };
}

describe("loadConfig defaults", () => {
  it("uses the default values when only the token is set", () => {
    expect(loadConfig(env())).toEqual({
      token: TOKEN,
      gatewayUrl: "http://agent:8090",
      dataDir: "/edge-data",
      apiPort: 8080,
      proxyPort: 3128,
      providersFile: "/config/providers.yaml",
      notificationsFile: "/config/notifications.yaml",
      webFile: "/config/web.yaml",
      askTimeoutMs: 120000,
    });
  });
});

describe("loadConfig overrides", () => {
  it("reads every variable from the environment", () => {
    expect(
      loadConfig(
        env({
          GATEWAY_URL: "http://gw:9000",
          EDGE_DATA_DIR: "/srv/edge",
          EDGE_API_PORT: "18080",
          EDGE_PROXY_PORT: "13128",
          EDGE_PROVIDERS_FILE: "/srv/providers.yaml",
          EDGE_NOTIFICATIONS_FILE: "/srv/notifications.yaml",
          EDGE_WEB_FILE: "/srv/web.yaml",
          EDGE_ASK_TIMEOUT_MS: "5000",
        }),
      ),
    ).toEqual({
      token: TOKEN,
      gatewayUrl: "http://gw:9000",
      dataDir: "/srv/edge",
      apiPort: 18080,
      proxyPort: 13128,
      providersFile: "/srv/providers.yaml",
      notificationsFile: "/srv/notifications.yaml",
      webFile: "/srv/web.yaml",
      askTimeoutMs: 5000,
    });
  });

  it("removes the trailing slash from GATEWAY_URL", () => {
    expect(loadConfig(env({ GATEWAY_URL: "http://gw:9000/" })).gatewayUrl).toBe("http://gw:9000");
  });
});

describe("AGENT_API_TOKEN", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["31 characters", "x".repeat(31)],
    ["with an inner space", `${"x".repeat(16)} ${"x".repeat(15)}`],
    ["with a trailing newline", `${TOKEN}\n`],
  ])("throws when the token is %s, without echoing it", (_label, token) => {
    let message = "";
    try {
      loadConfig({ AGENT_API_TOKEN: token });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    if (token !== undefined && token.length > 0) {
      expect(message).not.toContain(token.trim());
      expect(message).not.toContain(token);
    }
    expect(message).not.toContain("x".repeat(16));
  });

  it("names the variable and the generator command when it is missing", () => {
    expect(() => loadConfig({})).toThrow(
      "AGENT_API_TOKEN is required (generate one with: openssl rand -hex 32)",
    );
  });

  it("does not trim a token with surrounding whitespace", () => {
    expect(() => loadConfig(env({ AGENT_API_TOKEN: ` ${TOKEN}` }))).toThrow(Error);
  });
});

describe("GATEWAY_URL validation", () => {
  it.each([
    "https://gw:9000",
    "http://u:p@gw:9000",
    "http://gw:9000/api",
    "http://gw:9000/?a=1",
    "not a url",
  ])("throws for %s", (gatewayUrl) => {
    expect(() => loadConfig(env({ GATEWAY_URL: gatewayUrl }))).toThrow(Error);
  });

  it("does not echo credentials from GATEWAY_URL in the message", () => {
    let message = "";
    try {
      loadConfig(env({ GATEWAY_URL: "http://user:s3cret@gw:9000" }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("s3cret");
  });
});

describe("EDGE_DATA_DIR validation", () => {
  it("throws for a relative path", () => {
    expect(() => loadConfig(env({ EDGE_DATA_DIR: "relative/dir" }))).toThrow(
      "EDGE_DATA_DIR must be an absolute path",
    );
  });
});

describe("port validation", () => {
  it("throws for port 0", () => {
    expect(() => loadConfig(env({ EDGE_API_PORT: "0" }))).toThrow(Error);
  });

  it("throws for a non-numeric proxy port", () => {
    expect(() => loadConfig(env({ EDGE_PROXY_PORT: "abc" }))).toThrow(Error);
  });

  it("throws when the API port equals the default proxy port", () => {
    expect(() => loadConfig(env({ EDGE_API_PORT: "3128" }))).toThrow(
      "EDGE_API_PORT and EDGE_PROXY_PORT must be different",
    );
  });

  it("throws when both ports are equal", () => {
    expect(() => loadConfig(env({ EDGE_API_PORT: "9000", EDGE_PROXY_PORT: "9000" }))).toThrow(
      Error,
    );
  });
});

describe("EDGE_PROVIDERS_FILE validation", () => {
  it("throws for a relative path without echoing it", () => {
    let message = "";
    try {
      loadConfig(env({ EDGE_PROVIDERS_FILE: "config/providers.yaml" }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("EDGE_PROVIDERS_FILE must be an absolute path");
  });
});

describe("EDGE_NOTIFICATIONS_FILE and EDGE_WEB_FILE validation", () => {
  it("accepts absolute paths", () => {
    const config = loadConfig(
      env({ EDGE_NOTIFICATIONS_FILE: "/run/notifications.yaml", EDGE_WEB_FILE: "/run/web.yaml" }),
    );
    expect(config.notificationsFile).toBe("/run/notifications.yaml");
    expect(config.webFile).toBe("/run/web.yaml");
  });

  it("throws for a relative EDGE_NOTIFICATIONS_FILE and names the variable", () => {
    expect(() => loadConfig(env({ EDGE_NOTIFICATIONS_FILE: "config/notifications.yaml" }))).toThrow(
      "EDGE_NOTIFICATIONS_FILE must be an absolute path",
    );
  });

  it("throws for a relative EDGE_WEB_FILE and names the variable", () => {
    expect(() => loadConfig(env({ EDGE_WEB_FILE: "web.yaml" }))).toThrow(
      "EDGE_WEB_FILE must be an absolute path",
    );
  });
});

describe("EDGE_ASK_TIMEOUT_MS validation", () => {
  it.each(["999", "3600001", "abc", "1e4", "", "-5000", "5000.5"])(
    "throws for %j, without echoing it",
    (value) => {
      expect(() => loadConfig(env({ EDGE_ASK_TIMEOUT_MS: value }))).toThrow(
        "EDGE_ASK_TIMEOUT_MS must be an integer between 1000 and 3600000",
      );
    },
  );

  it("accepts the bounds", () => {
    expect(loadConfig(env({ EDGE_ASK_TIMEOUT_MS: "1000" })).askTimeoutMs).toBe(1000);
    expect(loadConfig(env({ EDGE_ASK_TIMEOUT_MS: "3600000" })).askTimeoutMs).toBe(3600000);
  });
});
