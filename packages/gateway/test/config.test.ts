import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GatewayConfig, gatewayPaths, loadGatewayConfig } from "../src/config.js";

describe("loadGatewayConfig", () => {
  it("uses the defaults when no variable is set", () => {
    const config = loadGatewayConfig({});

    expect(config.port).toBe(8090);
    expect(config.dataDir).toBe("/data");
    expect(config.providersFile).toBe("/config/providers.yaml");
    expect(config.extensionsDir.endsWith("/packages/extensions")).toBe(true);
    expect(existsSync(join(config.extensionsDir, "src", "ask-user.ts"))).toBe(true);
  });

  it("reads the values of the variables", () => {
    const config = loadGatewayConfig({
      GATEWAY_PORT: "9000",
      CNA_DATA_DIR: "/srv/cna",
      CNA_PROVIDERS_FILE: "/etc/cna/providers.yaml",
      CNA_EXTENSIONS_DIR: "/opt/cna/extensions",
      CNA_GIT_USER_NAME: "Agent",
      CNA_GIT_USER_EMAIL: "agent@example.invalid",
    });

    expect(config).toStrictEqual({
      port: 9000,
      dataDir: "/srv/cna",
      providersFile: "/etc/cna/providers.yaml",
      extensionsDir: "/opt/cna/extensions",
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
    });
  });

  it("rejects a relative path without repeating its value", () => {
    expect(() => loadGatewayConfig({ CNA_DATA_DIR: "rel-dir-value" })).toThrow(
      "CNA_DATA_DIR must be an absolute path",
    );
    try {
      loadGatewayConfig({ CNA_PROVIDERS_FILE: "rel-file-value.yaml" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("CNA_PROVIDERS_FILE must be an absolute path");
    }
    expect(() => loadGatewayConfig({ CNA_EXTENSIONS_DIR: "rel-ext-value" })).toThrow(
      "CNA_EXTENSIONS_DIR must be an absolute path",
    );
  });

  it("rejects an invalid port", () => {
    for (const value of ["0", "65536", "abc", "80.5", "-1"]) {
      expect(() => loadGatewayConfig({ GATEWAY_PORT: value })).toThrow(
        "GATEWAY_PORT must be an integer between 1 and 65535",
      );
    }
  });

  it("does not repeat the invalid port value", () => {
    try {
      loadGatewayConfig({ GATEWAY_PORT: "port-secret-70000" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("port-secret-70000");
    }
  });

  it("treats an empty git identity as absent", () => {
    const config = loadGatewayConfig({ CNA_GIT_USER_NAME: "", CNA_GIT_USER_EMAIL: "" });

    expect(config.gitUserName).toBeUndefined();
    expect(config.gitUserEmail).toBeUndefined();
  });
});

describe("gatewayPaths", () => {
  it("derives every path from the configuration", () => {
    const config: GatewayConfig = {
      port: 8090,
      dataDir: "/data",
      providersFile: "/config/providers.yaml",
      extensionsDir: "/app/packages/extensions",
    };

    expect(gatewayPaths(config)).toStrictEqual({
      workspaceDir: "/data/workspace/repo",
      agentDir: "/data/config/pi",
      sessionDir: "/data/sessions",
      extensions: [
        "/app/packages/extensions/src/ask-user.ts",
        "/app/packages/extensions/src/git.ts",
      ],
      systemPromptFile: "/app/packages/extensions/assets/system-prompt.md",
      globalAgentsFile: "/app/packages/extensions/assets/AGENTS.md",
    });
  });
});
