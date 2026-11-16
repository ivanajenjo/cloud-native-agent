import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ModelRefSchema } from "./session.js";

/**
 * `config/providers.yaml`, mounted read-only in the agent (translated to Pi's `models.json`)
 * and in edge (its endpoints are allowed even if internal; ADR-0008).
 */

const ProviderIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "invalid provider id");

export const ProviderModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderConfigSchema = z
  .object({
    /** http(s) URL without credentials. Required for non-built-in providers (Pi checks it). */
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .refine((value) => {
        const url = new URL(value);
        return url.username === "" && url.password === "";
      }, "baseUrl must not contain credentials")
      .optional(),
    /** e.g. "openai-completions", "anthropic-messages". */
    api: z.string().min(1).optional(),
    /**
     * Pi syntax: "$ENV_NAME" (recommended) or a literal. If absent, the gateway writes a
     * placeholder, because Pi requires one even for providers that ignore it (Ollama).
     */
    apiKey: z.string().min(1).optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
    models: z.array(ProviderModelSchema).default([]),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProvidersConfigSchema = z
  .object({
    /** `provider/model-id` used when `POST /session` has no `model`. */
    default: ModelRefSchema.optional(),
    providers: z.record(ProviderIdSchema, ProviderConfigSchema).default({}),
  })
  .strict();
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

/**
 * Parses and validates the text of `providers.yaml`. An empty file is an empty config.
 * Throws an `Error` whose message names the offending path; it never includes `apiKey` values.
 */
export function parseProvidersConfig(text: string): ProvidersConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "parse error";
    throw new Error(`providers.yaml: invalid YAML: ${detail}`);
  }
  const result = ProvidersConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new Error(`providers.yaml: ${path}: ${issue?.message ?? "invalid value"}`);
  }
  return result.data;
}

/** A provider endpoint edge must allow: lowercase host (IPv6 without brackets) and port. */
export interface ProviderEndpoint {
  provider: string;
  host: string;
  port: number;
}

/** Endpoints of the providers that set `baseUrl`; the port defaults to 80/443 by scheme. */
export function providerEndpoints(config: ProvidersConfig): ProviderEndpoint[] {
  const endpoints: ProviderEndpoint[] = [];
  for (const [provider, settings] of Object.entries(config.providers)) {
    if (settings.baseUrl === undefined) continue;
    const url = new URL(settings.baseUrl);
    const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    endpoints.push({ provider, host, port });
  }
  return endpoints;
}
