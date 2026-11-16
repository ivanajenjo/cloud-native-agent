import { readFile } from "node:fs/promises";
import {
  type NotificationEvent,
  type NotificationsConfig,
  parseNotificationsConfig,
  resolveSecretRef,
  TELEGRAM_API_BASE,
} from "@cna/shared";

/** A status change worth telling the user about. */
export interface Notification {
  event: NotificationEvent;
  title: string;
  message: string;
}

export interface Notifier {
  /** Sends the notification if its event is enabled. Never rejects. */
  notify(notification: Notification): Promise<void>;
}

export interface NotifierOptions {
  config: NotificationsConfig;
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch; // default globalThis.fetch
  logError?: (message: string) => void; // default console.error
  timeoutMs?: number; // default 10_000
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Sends push notifications through ntfy or Telegram. Errors are logged without the secrets: the
 * Telegram token travels in the URL path, so neither the URL nor the message of a fetch error is
 * ever logged.
 */
export function createNotifier(options: NotifierOptions): Notifier {
  const { config, env } = options;
  const fetchImpl: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const logError = options.logError ?? ((message: string) => console.error(message));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** POSTs a JSON body and reports failures through `logError`. Never throws. */
  async function post(
    provider: NotificationsConfig["provider"],
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The error message may contain the URL, and with it the Telegram token: not logged.
      logError(`notifications: ${provider} request failed`);
      return;
    }
    if (!response.ok) {
      logError(`notifications: ${provider} answered HTTP ${response.status}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  async function sendNtfy(notification: Notification): Promise<void> {
    const ntfy = config.ntfy;
    if (ntfy === undefined) {
      logError("notifications: the ntfy section is missing");
      return;
    }
    const headers: Record<string, string> = {};
    const token = ntfy.token === undefined ? undefined : resolveSecretRef(ntfy.token, env);
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    const base = ntfy.url.replace(/\/$/, "");
    await post("ntfy", `${base}/`, headers, {
      topic: ntfy.topic,
      title: notification.title,
      message: notification.message,
    });
  }

  async function sendTelegram(notification: Notification): Promise<void> {
    const telegram = config.telegram;
    if (telegram === undefined) {
      logError("notifications: the telegram section is missing");
      return;
    }
    const token = resolveSecretRef(telegram.botToken, env);
    if (token === undefined) {
      logError("notifications: the Telegram bot token is not set");
      return;
    }
    await post(
      "telegram",
      `${TELEGRAM_API_BASE}/bot${token}/sendMessage`,
      {},
      {
        chat_id: telegram.chatId,
        text: `${notification.title}\n${notification.message}`,
        disable_web_page_preview: true,
      },
    );
  }

  return {
    async notify(notification: Notification): Promise<void> {
      if (config.events !== undefined && !config.events.includes(notification.event)) {
        return;
      }
      try {
        if (config.provider === "ntfy") {
          await sendNtfy(notification);
        } else {
          await sendTelegram(notification);
        }
      } catch {
        logError(`notifications: ${config.provider} failed unexpectedly`);
      }
    },
  };
}

/**
 * Reads and parses `notifications.yaml`. A missing file (ENOENT) yields `undefined`, which
 * disables the notifications. Parse and validation errors propagate.
 */
export async function loadNotificationsConfig(
  path: string,
): Promise<NotificationsConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return parseNotificationsConfig(text);
}

/**
 * Resolved secret values of the config (ntfy token, Telegram bot token), for the redactor.
 * References that cannot be resolved are skipped.
 */
export function notificationSecrets(
  config: NotificationsConfig,
  env: Record<string, string | undefined>,
): string[] {
  const candidates = [config.ntfy?.token, config.telegram?.botToken];
  const secrets: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const value = resolveSecretRef(candidate, env);
    if (value !== undefined) secrets.push(value);
  }
  return secrets;
}
