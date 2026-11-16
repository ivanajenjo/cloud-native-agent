import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ModelInfo,
  type ModelsResponse,
  type ProvidersConfig,
  parseProvidersConfig,
} from "@cna/shared";

/** Pi requires an apiKey even for providers that ignore it (Ollama). */
export const PLACEHOLDER_API_KEY = "cna-no-key";

/** The models.json object Pi reads. Only the fields we emit. */
export interface PiModelsJson {
  providers: Record<string, Record<string, unknown>>;
}

/** Compat defaults for OpenAI-compatible endpoints such as Ollama (overridable by the user). */
const OPENAI_COMPLETIONS_COMPAT_DEFAULTS: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
};

const MODELS_JSON_FILE = "models.json";

/** Translates `providers.yaml` into the `models.json` object Pi reads. */
export function buildModelsJson(config: ProvidersConfig): PiModelsJson {
  const providers: Record<string, Record<string, unknown>> = {};

  for (const [providerId, provider] of Object.entries(config.providers)) {
    const out: Record<string, unknown> = {};

    if (provider.baseUrl !== undefined) out.baseUrl = provider.baseUrl;
    if (provider.api !== undefined) out.api = provider.api;

    if (provider.apiKey !== undefined) {
      out.apiKey = provider.apiKey;
    } else if (provider.baseUrl !== undefined) {
      // Own provider: Pi needs a key even if the endpoint ignores it.
      out.apiKey = PLACEHOLDER_API_KEY;
    }
    // Built-in provider without apiKey: Pi reads its own environment variable.

    if (provider.api === "openai-completions") {
      out.compat = { ...OPENAI_COMPLETIONS_COMPAT_DEFAULTS, ...provider.compat };
    } else if (provider.compat !== undefined) {
      out.compat = provider.compat;
    }

    if (provider.models.length > 0) {
      out.models = provider.models.map((model) => {
        const entry: Record<string, unknown> = { id: model.id };
        if (model.name !== undefined) entry.name = model.name;
        if (model.reasoning !== undefined) entry.reasoning = model.reasoning;
        if (model.input !== undefined) entry.input = model.input;
        if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
        if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens;
        if (model.compat !== undefined) entry.compat = model.compat;
        return entry;
      });
    }

    providers[providerId] = out;
  }

  return { providers };
}

/** Lists the models of the config for `GET /models`, in order of appearance. */
export function listModels(config: ProvidersConfig): ModelsResponse {
  const models: ModelInfo[] = [];

  for (const [provider, settings] of Object.entries(config.providers)) {
    for (const model of settings.models) {
      const info: ModelInfo = {
        ref: `${provider}/${model.id}`,
        provider,
        modelId: model.id,
      };
      if (model.name !== undefined) info.name = model.name;
      if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow;
      models.push(info);
    }
  }

  return { default: config.default ?? null, models };
}

const API_KEY_INTERPOLATION = /\$(?:(\$|!)|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Values of the `apiKey` fields of the config, for the redactor: literals as written and
 * `$NAME` / `${NAME}` references resolved against `env` (Pi's syntax; `$$` and `$!` are a literal
 * `$` and `!`). Keys whose value cannot be known here are skipped: `!command` keys and
 * references to variables that are not set.
 */
export function providerSecrets(
  config: ProvidersConfig,
  env: Record<string, string | undefined>,
): string[] {
  const secrets: string[] = [];
  for (const provider of Object.values(config.providers)) {
    const apiKey = provider.apiKey;
    if (apiKey === undefined || apiKey.startsWith("!")) {
      continue;
    }
    let resolved = true;
    const value = apiKey.replace(
      API_KEY_INTERPOLATION,
      (
        _match,
        escaped: string | undefined,
        braced: string | undefined,
        bare: string | undefined,
      ) => {
        if (escaped !== undefined) {
          return escaped;
        }
        const found = env[braced ?? bare ?? ""];
        if (found === undefined) {
          resolved = false;
          return "";
        }
        return found;
      },
    );
    if (resolved && value !== "") {
      secrets.push(value);
    }
  }
  return secrets;
}

/** Reads and parses the file. A missing file (ENOENT) yields `{ providers: {} }`. */
export async function loadProvidersConfig(path: string): Promise<ProvidersConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { providers: {} };
    }
    throw error;
  }
  return parseProvidersConfig(text);
}

/**
 * Writes `<dir>/models.json` atomically (temporary file with mode 0o600, then rename).
 * Creates `dir` if missing.
 */
export async function writeModelsJson(dir: string, config: ProvidersConfig): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, MODELS_JSON_FILE);
  const tmp = `${target}.tmp`;
  const content = `${JSON.stringify(buildModelsJson(config), null, 2)}\n`;

  await writeFile(tmp, content, { mode: 0o600 });
  // writeFile does not change the mode of a temporary file left over from an earlier run.
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}
