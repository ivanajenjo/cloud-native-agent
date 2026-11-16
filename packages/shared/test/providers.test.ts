import { describe, expect, it } from "vitest";
import { parseProvidersConfig, providerEndpoints } from "../src/index.js";

const EXAMPLE = `
default: ollama/qwen3-coder:30b
providers:
  ollama:
    baseUrl: http://192.168.1.50:11434/v1
    api: openai-completions
    models:
      - id: qwen3-coder:30b
        contextWindow: 65536
`;

describe("parseProvidersConfig", () => {
  it("returns an empty config for an empty file", () => {
    expect(parseProvidersConfig("")).toEqual({ providers: {} });
  });

  it("parses the example config", () => {
    const config = parseProvidersConfig(EXAMPLE);
    expect(config.default).toBe("ollama/qwen3-coder:30b");
    expect(config.providers.ollama).toEqual({
      baseUrl: "http://192.168.1.50:11434/v1",
      api: "openai-completions",
      models: [{ id: "qwen3-coder:30b", contextWindow: 65536 }],
    });
  });

  it("defaults models to an empty array", () => {
    const config = parseProvidersConfig(`
providers:
  local:
    baseUrl: http://localhost:8080/v1
`);
    expect(config.providers.local?.models).toEqual([]);
  });

  it("throws with a prefix when the YAML is invalid", () => {
    expect(() => parseProvidersConfig("a: [1, 2")).toThrow(/^providers\.yaml: invalid YAML/);
  });

  it("rejects a baseUrl with credentials without leaking them", () => {
    const text = `
providers:
  ollama:
    baseUrl: http://user:pass@host/v1
`;
    let message = "";
    try {
      parseProvidersConfig(text);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("pass");
  });

  it("rejects a baseUrl that is not http(s)", () => {
    expect(() =>
      parseProvidersConfig(`
providers:
  ollama:
    baseUrl: ftp://x
`),
    ).toThrow();
  });

  it("rejects an unknown field and names its path", () => {
    expect(() =>
      parseProvidersConfig(`
providers:
  ollama:
    baseUrl: http://localhost:11434/v1
    unknownField: true
`),
    ).toThrow(/providers\.ollama/);
  });

  it("does not leak apiKey values in validation errors", () => {
    const text = `
providers:
  ollama:
    apiKey: "sk-SECRET123"
    models:
      - id: m
        contextWindow: -1
`;
    let message = "";
    try {
      parseProvidersConfig(text);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("sk-SECRET123");
  });
});

describe("providerEndpoints", () => {
  it("defaults the port of http to 80", () => {
    const config = parseProvidersConfig(`
providers:
  p:
    baseUrl: http://ollama.lan/v1
`);
    expect(providerEndpoints(config)).toEqual([{ provider: "p", host: "ollama.lan", port: 80 }]);
  });

  it("defaults the port of https to 443", () => {
    const config = parseProvidersConfig(`
providers:
  p:
    baseUrl: https://api.example.com/v1
`);
    expect(providerEndpoints(config)).toEqual([
      { provider: "p", host: "api.example.com", port: 443 },
    ]);
  });

  it("uses the explicit port", () => {
    const config = parseProvidersConfig(EXAMPLE);
    expect(providerEndpoints(config)).toEqual([
      { provider: "ollama", host: "192.168.1.50", port: 11434 },
    ]);
  });

  it("lowercases the host", () => {
    const config = parseProvidersConfig(`
providers:
  p:
    baseUrl: http://OLLAMA.lan:11434
`);
    expect(providerEndpoints(config)[0]?.host).toBe("ollama.lan");
  });

  it("returns IPv6 hosts without brackets", () => {
    const config = parseProvidersConfig(`
providers:
  p:
    baseUrl: "http://[fd00::1]:11434/v1"
`);
    expect(providerEndpoints(config)).toEqual([{ provider: "p", host: "fd00::1", port: 11434 }]);
  });

  it("skips providers without baseUrl", () => {
    const config = parseProvidersConfig(`
providers:
  builtin:
    api: anthropic-messages
  ollama:
    baseUrl: http://ollama.lan:11434/v1
`);
    expect(providerEndpoints(config)).toEqual([
      { provider: "ollama", host: "ollama.lan", port: 11434 },
    ]);
  });
});
