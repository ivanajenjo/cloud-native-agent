import { describe, expect, it } from "vitest";
import {
  parseNotificationsConfig,
  parseWebConfig,
  resolveSecretRef,
  serviceEndpoints,
} from "../src/index.js";

/** Runs `fn` and returns the thrown message, or "" when it does not throw. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("parseNotificationsConfig", () => {
  it("parses an ntfy config without token", () => {
    const config = parseNotificationsConfig(`
provider: ntfy
ntfy:
  url: https://ntfy.sh
  topic: my-agent_1
`);
    expect(config).toEqual({
      provider: "ntfy",
      ntfy: { url: "https://ntfy.sh", topic: "my-agent_1" },
    });
  });

  it("parses an ntfy config with token and events", () => {
    const config = parseNotificationsConfig(`
provider: ntfy
events: [waiting_input, error]
ntfy:
  url: http://ntfy.local:8081
  topic: agent
  token: $NTFY_TOKEN
`);
    expect(config.events).toEqual(["waiting_input", "error"]);
    expect(config.ntfy?.token).toBe("$NTFY_TOKEN");
  });

  it.each([
    ["a numeric chat id", "123456789"],
    ["a negative chat id", "-1001234567890"],
    ["a channel", "@canal_x"],
  ])("parses a telegram config with %s", (_name, chatId) => {
    const config = parseNotificationsConfig(`
provider: telegram
telegram:
  botToken: $TELEGRAM_BOT_TOKEN
  chatId: "${chatId}"
`);
    expect(config.telegram).toEqual({ botToken: "$TELEGRAM_BOT_TOKEN", chatId });
  });

  it("throws when the file is empty (provider is required)", () => {
    expect(() => parseNotificationsConfig("")).toThrow(/^notifications\.yaml: /);
  });

  it("throws when the provider section is missing", () => {
    expect(() => parseNotificationsConfig("provider: ntfy\n")).toThrow(/^notifications\.yaml: /);
  });

  it("throws for an invalid ntfy topic", () => {
    expect(() =>
      parseNotificationsConfig(`
provider: ntfy
ntfy:
  url: https://ntfy.sh
  topic: a/b
`),
    ).toThrow(/^notifications\.yaml: /);
  });

  it("throws for a url with credentials", () => {
    expect(() =>
      parseNotificationsConfig(`
provider: ntfy
ntfy:
  url: https://user:pass@ntfy.sh
  topic: agent
`),
    ).toThrow(/^notifications\.yaml: /);
  });

  it("throws for an empty events list", () => {
    expect(() =>
      parseNotificationsConfig(`
provider: ntfy
events: []
ntfy:
  url: https://ntfy.sh
  topic: agent
`),
    ).toThrow(/^notifications\.yaml: /);
  });

  it("throws with a prefix for invalid YAML", () => {
    expect(() => parseNotificationsConfig("provider: [ntfy")).toThrow(
      /^notifications\.yaml: invalid YAML/,
    );
  });

  it("never includes a literal token in error messages", () => {
    const token = "tok_LITERAL_SECRET_12345";
    const texts = [
      `provider: ntfy\nntfy:\n  url: https://ntfy.sh\n  topic: a/b\n  token: ${token}\n`,
      `provider: telegram\ntelegram:\n  botToken: ${token}\n  chatId: "bad id"\n`,
      `provider: telegram\ntelegram:\n  botToken: ${token}\n  chatId: "@x"\n`,
      `provider: ntfy\nntfy: [${token}\n`,
    ];
    for (const text of texts) {
      expect(messageOf(() => parseNotificationsConfig(text))).not.toContain(token);
    }
  });
});

describe("parseWebConfig", () => {
  it("returns an empty config for an empty file", () => {
    expect(parseWebConfig("")).toEqual({});
  });

  it("parses searxng with url", () => {
    expect(
      parseWebConfig(`
search:
  provider: searxng
  url: http://searxng:8080
`),
    ).toEqual({ search: { provider: "searxng", url: "http://searxng:8080" } });
  });

  it.each(["brave", "tavily"])("parses %s with apiKey", (provider) => {
    expect(
      parseWebConfig(`
search:
  provider: ${provider}
  apiKey: $SEARCH_API_KEY
`),
    ).toEqual({ search: { provider, apiKey: "$SEARCH_API_KEY" } });
  });

  it.each([
    ["searxng without url", "search:\n  provider: searxng\n"],
    [
      "searxng with apiKey",
      "search:\n  provider: searxng\n  url: http://searxng:8080\n  apiKey: k\n",
    ],
    ["brave without apiKey", "search:\n  provider: brave\n"],
    ["brave with url", "search:\n  provider: brave\n  apiKey: k\n  url: http://x:8080\n"],
  ])("throws for %s", (_name, text) => {
    expect(() => parseWebConfig(text)).toThrow(/^web\.yaml: /);
  });

  it("throws with a prefix for invalid YAML", () => {
    expect(() => parseWebConfig("search: [brave")).toThrow(/^web\.yaml: invalid YAML/);
  });
});

describe("resolveSecretRef", () => {
  it("resolves $NAME from the environment", () => {
    expect(resolveSecretRef("$X", { X: "value" })).toBe("value");
  });

  it("returns undefined when the variable is empty or missing", () => {
    expect(resolveSecretRef("$X", { X: "" })).toBeUndefined();
    expect(resolveSecretRef("$X", {})).toBeUndefined();
  });

  it("returns a literal as is", () => {
    expect(resolveSecretRef("literal-secret", { X: "value" })).toBe("literal-secret");
  });

  it.each(["$1X", "$X-Y"])("treats %s as a literal", (value) => {
    expect(resolveSecretRef(value, { X: "value", "1X": "other" })).toBe(value);
  });
});

describe("serviceEndpoints", () => {
  it("uses port 443 for an https ntfy url without port", () => {
    expect(
      serviceEndpoints({
        notifications: {
          provider: "ntfy",
          ntfy: { url: "https://ntfy.sh", topic: "agent" },
        },
      }),
    ).toEqual([{ service: "notifications", host: "ntfy.sh", port: 443 }]);
  });

  it("uses the explicit port of an http ntfy url", () => {
    expect(
      serviceEndpoints({
        notifications: {
          provider: "ntfy",
          ntfy: { url: "http://ntfy.local:8081", topic: "agent" },
        },
      }),
    ).toEqual([{ service: "notifications", host: "ntfy.local", port: 8081 }]);
  });

  it("returns the telegram API endpoint", () => {
    expect(
      serviceEndpoints({
        notifications: {
          provider: "telegram",
          telegram: { botToken: "$T", chatId: "123" },
        },
      }),
    ).toEqual([{ service: "notifications", host: "api.telegram.org", port: 443 }]);
  });

  it("returns the searxng endpoint with its port", () => {
    expect(
      serviceEndpoints({
        web: { search: { provider: "searxng", url: "http://searxng:8080" } },
      }),
    ).toEqual([{ service: "web_search", host: "searxng", port: 8080 }]);
  });

  it("returns the brave endpoint", () => {
    expect(serviceEndpoints({ web: { search: { provider: "brave", apiKey: "$B" } } })).toEqual([
      { service: "web_search", host: "api.search.brave.com", port: 443 },
    ]);
  });

  it("returns the tavily endpoint", () => {
    expect(serviceEndpoints({ web: { search: { provider: "tavily", apiKey: "$T" } } })).toEqual([
      { service: "web_search", host: "api.tavily.com", port: 443 },
    ]);
  });

  it("lowercases the host", () => {
    expect(
      serviceEndpoints({
        web: { search: { provider: "searxng", url: "http://SearXNG.Local:8080" } },
      }),
    ).toEqual([{ service: "web_search", host: "searxng.local", port: 8080 }]);
  });

  it("returns an IPv6 host without brackets", () => {
    expect(
      serviceEndpoints({
        web: { search: { provider: "searxng", url: "http://[::1]:8080" } },
      }),
    ).toEqual([{ service: "web_search", host: "::1", port: 8080 }]);
  });

  it("returns an empty list without configs", () => {
    expect(serviceEndpoints({})).toEqual([]);
  });
});
