import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPiLaunch, type PiLaunchOptions, resolvePiCli } from "../src/pi/launch.js";

const base: PiLaunchOptions = {
  piCli: "/opt/pi/dist/bundle/cli.js",
  cwd: "/data/workspace/repo",
  agentDir: "/data/pi-agent",
  sessionDir: "/data/sessions",
  extensions: [],
  baseBranch: "main",
  autoPush: false,
  env: {},
  nodePath: "/usr/bin/node",
};

const full: PiLaunchOptions = {
  ...base,
  extensions: ["/opt/cna/ext/ask-user.js", "/opt/cna/ext/git.js"],
  systemPromptFile: "/data/prompts/system.md",
  model: "anthropic/claude-sonnet-4",
  thinking: "high",
  baseBranch: "develop",
  autoPush: true,
};

describe("buildPiLaunch args", () => {
  it("builds the arguments in the exact order with all options", () => {
    const spec = buildPiLaunch({ ...full, env: {} });

    expect(spec.command).toBe("/usr/bin/node");
    expect(spec.cwd).toBe("/data/workspace/repo");
    expect(spec.args).toEqual([
      "/opt/pi/dist/bundle/cli.js",
      "--mode",
      "rpc",
      "--no-approve",
      "--no-extensions",
      "--no-mcp",
      "--session-dir",
      "/data/sessions",
      "-e",
      "/opt/cna/ext/ask-user.js",
      "-e",
      "/opt/cna/ext/git.js",
      "--append-system-prompt",
      "/data/prompts/system.md",
      "--model",
      "anthropic/claude-sonnet-4",
      "--thinking",
      "high",
      "--cna-base-branch",
      "develop",
      "--cna-auto-push",
    ]);
  });

  it("builds the minimal arguments without optional flags", () => {
    const spec = buildPiLaunch({ ...base, env: {} });

    expect(spec.args).toEqual([
      "/opt/pi/dist/bundle/cli.js",
      "--mode",
      "rpc",
      "--no-approve",
      "--no-extensions",
      "--no-mcp",
      "--session-dir",
      "/data/sessions",
      "--cna-base-branch",
      "main",
    ]);
    expect(spec.args).not.toContain("-e");
    expect(spec.args).not.toContain("--append-system-prompt");
    expect(spec.args).not.toContain("--model");
    expect(spec.args).not.toContain("--thinking");
    expect(spec.args).not.toContain("--cna-auto-push");
  });

  it("always contains the isolation flags and the rpc mode", () => {
    const spec = buildPiLaunch({ ...base, env: {} });

    expect(spec.args).toContain("--no-approve");
    expect(spec.args).toContain("--no-extensions");
    expect(spec.args).toContain("--no-mcp");
    const mode = spec.args.indexOf("--mode");
    expect(spec.args[mode + 1]).toBe("rpc");
  });

  it("defaults the command to process.execPath", () => {
    const { nodePath: _ignored, ...withoutNode } = base;
    const spec = buildPiLaunch({ ...withoutNode, env: {} });

    expect(spec.command).toBe(process.execPath);
  });
});

describe("buildPiLaunch env", () => {
  it("removes AGENT_API_TOKEN", () => {
    const spec = buildPiLaunch({
      ...base,
      env: { AGENT_API_TOKEN: "secret", PATH: "/usr/bin" },
    });

    expect(spec.env).not.toHaveProperty("AGENT_API_TOKEN");
    expect(spec.env.PATH).toBe("/usr/bin");
  });

  it("removes keys whose value is undefined", () => {
    const spec = buildPiLaunch({
      ...base,
      env: { MAYBE: undefined, PATH: "/usr/bin" },
    });

    expect(spec.env).not.toHaveProperty("MAYBE");
    expect(Object.values(spec.env).every((v) => typeof v === "string")).toBe(true);
  });

  it("forces the PI_* variables even when env sets other values", () => {
    const spec = buildPiLaunch({
      ...base,
      env: {
        PI_OFFLINE: "0",
        PI_TELEMETRY: "1",
        PI_SKIP_VERSION_CHECK: "0",
        PI_CODING_AGENT_DIR: "/somewhere/else",
      },
    });

    expect(spec.env.PI_OFFLINE).toBe("1");
    expect(spec.env.PI_TELEMETRY).toBe("0");
    expect(spec.env.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(spec.env.PI_CODING_AGENT_DIR).toBe("/data/pi-agent");
  });

  it("sets the PI_* variables when env does not provide them", () => {
    const spec = buildPiLaunch({ ...base, env: {} });

    expect(spec.env).toEqual({
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PI_CODING_AGENT_DIR: "/data/pi-agent",
    });
  });

  it("keeps GITHUB_TOKEN and HTTPS_PROXY and other inherited variables", () => {
    const spec = buildPiLaunch({
      ...base,
      env: {
        GITHUB_TOKEN: "ghp_x",
        HTTPS_PROXY: "http://proxy:3128",
        NODE_USE_ENV_PROXY: "1",
        ANTHROPIC_API_KEY: "sk-ant",
      },
    });

    expect(spec.env.GITHUB_TOKEN).toBe("ghp_x");
    expect(spec.env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(spec.env.NODE_USE_ENV_PROXY).toBe("1");
    expect(spec.env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("does not mutate the input env", () => {
    const env: Record<string, string | undefined> = {
      AGENT_API_TOKEN: "secret",
      PI_OFFLINE: "0",
      MAYBE: undefined,
      PATH: "/usr/bin",
    };
    const snapshot = { ...env };

    buildPiLaunch({ ...base, env });

    expect(env).toEqual(snapshot);
    expect("AGENT_API_TOKEN" in env).toBe(true);
    expect("MAYBE" in env).toBe(true);
  });
});

describe("buildPiLaunch validation", () => {
  it("rejects a relative cwd", () => {
    expect(() => buildPiLaunch({ ...base, cwd: "repo", env: {} })).toThrow(Error);
  });

  it("rejects a relative extension path", () => {
    expect(() => buildPiLaunch({ ...base, extensions: ["ext/git.js"], env: {} })).toThrow(Error);
  });

  it("rejects a relative piCli, agentDir, sessionDir and systemPromptFile", () => {
    expect(() => buildPiLaunch({ ...base, piCli: "cli.js", env: {} })).toThrow(Error);
    expect(() => buildPiLaunch({ ...base, agentDir: "agent", env: {} })).toThrow(Error);
    expect(() => buildPiLaunch({ ...base, sessionDir: "sessions", env: {} })).toThrow(Error);
    expect(() => buildPiLaunch({ ...base, systemPromptFile: "prompt.md", env: {} })).toThrow(Error);
  });

  it("rejects a baseBranch that looks like a flag", () => {
    expect(() => buildPiLaunch({ ...base, baseBranch: "--force", env: {} })).toThrow(Error);
  });

  it("rejects an empty baseBranch", () => {
    expect(() => buildPiLaunch({ ...base, baseBranch: "", env: {} })).toThrow(Error);
  });

  it("rejects a model that looks like a flag", () => {
    expect(() => buildPiLaunch({ ...base, model: "-x", env: {} })).toThrow(Error);
  });
});

describe("resolvePiCli", () => {
  it("returns an absolute path to dist/bundle/cli.js that exists", () => {
    const cli = resolvePiCli();

    expect(cli.startsWith("/")).toBe(true);
    expect(cli.endsWith("dist/bundle/cli.js")).toBe(true);
    expect(existsSync(cli)).toBe(true);
  });
});
