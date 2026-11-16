import { parse as parseYaml } from "yaml";
import { type ZodType, z } from "zod";

/**
 * Auxiliary services of phase 2 (ADR-0009): push notifications (`config/notifications.yaml`)
 * and web search (`config/web.yaml`). Both files are mounted read-only in the agent and in
 * edge, which allows their endpoints like those of providers.yaml (ADR-0008).
 */

/** Secret values use Pi's syntax: "$ENV_NAME" (recommended) or a literal. */
const SecretRefSchema = z.string().min(1);

/** http(s) URL without credentials. */
const ServiceUrlSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return url.username === "" && url.password === "";
}, "url must not contain credentials");

export const NOTIFICATION_EVENTS = ["waiting_input", "ready", "error"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export const NotificationsConfigSchema = z
  .object({
    provider: z.enum(["ntfy", "telegram"]),
    /** Status changes that send a notification. Default: all of NOTIFICATION_EVENTS. */
    events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).optional(),
    ntfy: z
      .object({
        /** ntfy server, e.g. https://ntfy.sh or a self-hosted one. */
        url: ServiceUrlSchema,
        topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid ntfy topic"),
        /** Access token (Bearer), optional. */
        token: SecretRefSchema.optional(),
      })
      .strict()
      .optional(),
    telegram: z
      .object({
        botToken: SecretRefSchema,
        /** Numeric chat id (may be negative) or @channel. */
        chatId: z.string().regex(/^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$/, "invalid chatId"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((config) => config[config.provider] !== undefined, {
    message: "the section of the selected provider is missing",
  });
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const SEARCH_PROVIDERS = ["searxng", "brave", "tavily"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

/** Fixed API bases of the hosted search providers. */
export const SEARCH_API_BASES = {
  brave: "https://api.search.brave.com",
  tavily: "https://api.tavily.com",
} as const;

export const WebConfigSchema = z
  .object({
    search: z
      .object({
        provider: z.enum(SEARCH_PROVIDERS),
        /** SearXNG base URL (required for searxng, not allowed otherwise). */
        url: ServiceUrlSchema.optional(),
        /** API key (required for brave and tavily, not allowed for searxng). */
        apiKey: SecretRefSchema.optional(),
      })
      .strict()
      .refine((search) => (search.provider === "searxng") === (search.url !== undefined), {
        message: "url is required for searxng and only allowed for it",
      })
      .refine((search) => (search.provider === "searxng") === (search.apiKey === undefined), {
        message: "apiKey is required for brave and tavily and not allowed for searxng",
      })
      .optional(),
  })
  .strict();
export type WebConfig = z.infer<typeof WebConfigSchema>;

/**
 * Parses one YAML config file. An empty file is `{}`. Throws an `Error` whose message starts with
 * `<fileName>: ` and names the offending path; it never includes values.
 */
function parseConfigFile<T>(fileName: string, schema: ZodType<T>, text: string): T {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "parse error";
    throw new Error(`${fileName}: invalid YAML: ${detail}`);
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new Error(`${fileName}: ${path}: ${issue?.message ?? "invalid value"}`);
  }
  return result.data;
}

/** Parses `notifications.yaml`. An empty file is invalid (`provider` is required). */
export function parseNotificationsConfig(text: string): NotificationsConfig {
  return parseConfigFile("notifications.yaml", NotificationsConfigSchema, text);
}

/** Parses `web.yaml`. An empty file is a config without search. */
export function parseWebConfig(text: string): WebConfig {
  return parseConfigFile("web.yaml", WebConfigSchema, text);
}

/**
 * Value of a secret reference: "$NAME" → env.NAME (undefined if unset or empty); anything else
 * is a literal and returned as is.
 */
export function resolveSecretRef(
  value: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const resolved = env[value.slice(1)];
    return resolved === undefined || resolved === "" ? undefined : resolved;
  }
  return value;
}

/** A service endpoint edge must allow: lowercase host (IPv6 without brackets) and port. */
export interface ServiceEndpoint {
  service: "notifications" | "web_search";
  host: string;
  port: number;
}

function endpointOf(service: ServiceEndpoint["service"], base: string): ServiceEndpoint {
  const url = new URL(base);
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { service, host, port };
}

/** Endpoints of the configured services. A missing config contributes nothing. */
export function serviceEndpoints(configs: {
  notifications?: NotificationsConfig;
  web?: WebConfig;
}): ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = [];
  const { notifications, web } = configs;
  if (notifications?.provider === "ntfy" && notifications.ntfy !== undefined) {
    endpoints.push(endpointOf("notifications", notifications.ntfy.url));
  } else if (notifications?.provider === "telegram") {
    endpoints.push(endpointOf("notifications", TELEGRAM_API_BASE));
  }
  const search = web?.search;
  if (search !== undefined) {
    const base = search.provider === "searxng" ? search.url : SEARCH_API_BASES[search.provider];
    if (base !== undefined) {
      endpoints.push(endpointOf("web_search", base));
    }
  }
  return endpoints;
}
