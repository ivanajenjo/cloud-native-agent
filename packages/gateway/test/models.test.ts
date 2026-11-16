import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvidersConfig } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildModelsJson,
  listModels,
  loadProvidersConfig,
  PLACEHOLDER_API_KEY,
  providerSecrets,
  writeModelsJson,
} from "../src/config/models.js";

const OLLAMA_CONFIG: ProvidersConfig = {
  default: "ollama/qwen3-coder:30b",
  providers: {
    ollama: {
      baseUrl: "http://192.168.1.50:11434/v1",
      api: "openai-completions",
      models: [{ id: "qwen3-coder:30b", contextWindow: 65536 }],
    },
  },
};

describe("buildModelsJson", () => {
  it("translates the Ollama example of the plan", () => {
    expect(buildModelsJson(OLLAMA_CONFIG)).toStrictEqual({
      providers: {
        ollama: {
          baseUrl: "http://192.168.1.50:11434/v1",
          api: "openai-completions",
          apiKey: PLACEHOLDER_API_KEY,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "qwen3-coder:30b", contextWindow: 65536 }],
        },
      },
    });
  });

  it("lets the user compat override the default", () => {
    const config: ProvidersConfig = {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          compat: { supportsDeveloperRole: true },
          models: [],
        },
      },
    };

    const json = buildModelsJson(config);

    expect(json.providers.ollama?.compat).toStrictEqual({
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
    });
  });

  it("adds no default compat for anthropic-messages", () => {
    const config: ProvidersConfig = {
      providers: {
        proxy: {
          baseUrl: "https://proxy.example.com/v1",
          api: "anthropic-messages",
          models: [{ id: "claude-sonnet-5" }],
        },
      },
    };

    const provider = buildModelsJson(config).providers.proxy;

    expect(provider).not.toHaveProperty("compat");
    expect(provider?.apiKey).toBe(PLACEHOLDER_API_KEY);
  });

  it("copies apiKey with an environment reference literally", () => {
    const config: ProvidersConfig = {
      providers: {
        mine: {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "$MY_KEY",
          models: [],
        },
      },
    };

    expect(buildModelsJson(config).providers.mine?.apiKey).toBe("$MY_KEY");
  });

  it("omits apiKey for a built-in provider without baseUrl or apiKey", () => {
    const config: ProvidersConfig = {
      providers: {
        anthropic: { models: [{ id: "claude-sonnet-5", contextWindow: 200000 }] },
      },
    };

    const provider = buildModelsJson(config).providers.anthropic;

    expect(Object.keys(provider ?? {})).toStrictEqual(["models"]);
  });

  it("omits models when the list is empty and omits absent model fields", () => {
    const config: ProvidersConfig = {
      providers: {
        empty: { baseUrl: "http://localhost:1/v1", api: "openai-completions", models: [] },
        full: {
          baseUrl: "http://localhost:2/v1",
          models: [{ id: "bare" }],
        },
      },
    };

    const json = buildModelsJson(config);

    expect(Object.keys(json.providers.empty ?? {})).not.toContain("models");
    expect(json.providers.full?.models).toStrictEqual([{ id: "bare" }]);
  });

  it("copies all model fields that are present", () => {
    const config: ProvidersConfig = {
      providers: {
        p: {
          baseUrl: "http://localhost:3/v1",
          api: "openai-completions",
          models: [
            {
              id: "m",
              name: "Model",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1000,
              maxTokens: 100,
              compat: { thinkingFormat: "qwen" },
            },
          ],
        },
      },
    };

    expect(buildModelsJson(config).providers.p?.models).toStrictEqual([
      {
        id: "m",
        name: "Model",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000,
        maxTokens: 100,
        compat: { thinkingFormat: "qwen" },
      },
    ]);
  });
});

describe("listModels", () => {
  it("lists models in order of appearance with refs and default", () => {
    const config: ProvidersConfig = {
      default: "beta/two",
      providers: {
        alpha: {
          baseUrl: "http://localhost:1/v1",
          models: [{ id: "one", name: "One", contextWindow: 8000 }, { id: "zed" }],
        },
        beta: {
          models: [{ id: "two" }],
        },
      },
    };

    expect(listModels(config)).toStrictEqual({
      default: "beta/two",
      models: [
        {
          ref: "alpha/one",
          provider: "alpha",
          modelId: "one",
          name: "One",
          contextWindow: 8000,
        },
        { ref: "alpha/zed", provider: "alpha", modelId: "zed" },
        { ref: "beta/two", provider: "beta", modelId: "two" },
      ],
    });
  });

  it("returns default null when the config has none", () => {
    expect(listModels({ providers: {} })).toStrictEqual({ default: null, models: [] });
  });
});

describe("loadProvidersConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cna-models-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("yields an empty config when the file does not exist", async () => {
    await expect(loadProvidersConfig(join(dir, "missing.yaml"))).resolves.toStrictEqual({
      providers: {},
    });
  });

  it("parses a valid file", async () => {
    const path = join(dir, "providers.yaml");
    await writeFile(
      path,
      [
        "default: ollama/qwen3-coder:30b",
        "providers:",
        "  ollama:",
        "    baseUrl: http://192.168.1.50:11434/v1",
        "    api: openai-completions",
        "    models:",
        "      - id: qwen3-coder:30b",
        "        contextWindow: 65536",
        "",
      ].join("\n"),
    );

    await expect(loadProvidersConfig(path)).resolves.toStrictEqual(OLLAMA_CONFIG);
  });

  it("rejects invalid YAML", async () => {
    const path = join(dir, "providers.yaml");
    await writeFile(path, "providers: [unclosed\n");

    await expect(loadProvidersConfig(path)).rejects.toThrow(/providers\.yaml/);
  });
});

describe("writeModelsJson", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cna-models-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates the directory and writes models.json with mode 0600", async () => {
    const dir = join(root, "nested", "agent");

    await writeModelsJson(dir, OLLAMA_CONFIG);

    const file = join(dir, "models.json");
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toStrictEqual(buildModelsJson(OLLAMA_CONFIG));
    expect(text.endsWith("\n")).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    await writeModelsJson(root, OLLAMA_CONFIG);

    expect((await readdir(root)).sort()).toStrictEqual(["models.json"]);
  });
});

describe("providerSecrets", () => {
  const config = (keys: Record<string, string | undefined>): ProvidersConfig => ({
    providers: Object.fromEntries(
      Object.entries(keys).map(([id, apiKey]) => [id, { apiKey, models: [] }]),
    ),
  });

  it("returns literal keys as written", () => {
    expect(providerSecrets(config({ a: "sk-literal-key-123" }), {})).toStrictEqual([
      "sk-literal-key-123",
    ]);
  });

  it("resolves $NAME and the braced form against env", () => {
    const env = { MY_LLM_KEY: "value-from-env-1", OTHER: "value-from-env-2" };
    // Built with a join so the linter does not take the braces for a template placeholder.
    const braced = ["$", "{OTHER}"].join("");
    expect(providerSecrets(config({ a: "$MY_LLM_KEY", b: braced }), env)).toStrictEqual([
      "value-from-env-1",
      "value-from-env-2",
    ]);
  });

  it("treats $$ and $! as literal characters", () => {
    expect(providerSecrets(config({ a: "pa$$word$!end" }), {})).toStrictEqual(["pa$word!end"]);
  });

  it("skips providers without apiKey, !command keys and unset variables", () => {
    const keys = { none: undefined, command: "!pass show llm", unset: "$NOT_SET_ANYWHERE" };
    expect(providerSecrets(config(keys), {})).toStrictEqual([]);
  });
});
