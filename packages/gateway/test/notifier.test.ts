import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NotificationsConfig, parseNotificationsConfig } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNotifier,
  loadNotificationsConfig,
  type Notification,
  notificationSecrets,
} from "../src/notifications/notifier.js";

const NTFY_TOKEN = "ntfy-secret-token-123";
const BOT_TOKEN = "123456:telegram-secret-token";

const READY: Notification = { event: "ready", title: "Session done", message: "All tests pass" };
const ERROR: Notification = { event: "error", title: "Session failed", message: "Boom" };

const NTFY_CONFIG: NotificationsConfig = {
  provider: "ntfy",
  ntfy: { url: "https://ntfy.example.com", topic: "cna-alerts", token: "$NTFY_TOKEN" },
};

const TELEGRAM_CONFIG: NotificationsConfig = {
  provider: "telegram",
  telegram: { botToken: "$BOT_TOKEN", chatId: "-1001234567890" },
};

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}

function fetchMock(response: () => Promise<Response> | Response = okResponse) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response());
}

describe("createNotifier", () => {
  let logError: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeEach(() => {
    logError = vi.fn<(message: string) => void>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to ntfy with the JSON body and headers, with or without a trailing slash", async () => {
    for (const url of ["https://ntfy.example.com", "https://ntfy.example.com/"]) {
      const fetch = fetchMock();
      const notifier = createNotifier({
        config: {
          provider: "ntfy",
          ntfy: { url, topic: "cna-alerts" },
        },
        env: {},
        fetch,
        logError,
      });

      await notifier.notify(READY);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [target, init] = fetch.mock.calls[0] ?? [];
      expect(target).toBe("https://ntfy.example.com/");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toStrictEqual({ "Content-Type": "application/json" });
      expect(init?.body).toBe(
        JSON.stringify({
          topic: "cna-alerts",
          title: "Session done",
          message: "All tests pass",
        }),
      );
      expect(logError).not.toHaveBeenCalled();
    }
  });

  it("sends the ntfy token as Bearer only when the variable is set", async () => {
    const withToken = fetchMock();
    await createNotifier({
      config: NTFY_CONFIG,
      env: { NTFY_TOKEN },
      fetch: withToken,
      logError,
    }).notify(READY);
    expect(withToken.mock.calls[0]?.[1]?.headers).toStrictEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${NTFY_TOKEN}`,
    });

    const withoutToken = fetchMock();
    await createNotifier({
      config: NTFY_CONFIG,
      env: {},
      fetch: withoutToken,
      logError,
    }).notify(READY);
    expect(withoutToken.mock.calls[0]?.[1]?.headers).toStrictEqual({
      "Content-Type": "application/json",
    });
  });

  it("only sends the events listed in config.events", async () => {
    const fetch = fetchMock();
    const notifier = createNotifier({
      config: { ...NTFY_CONFIG, events: ["error"] },
      env: {},
      fetch,
      logError,
    });

    await notifier.notify(READY);
    expect(fetch).not.toHaveBeenCalled();

    await notifier.notify(ERROR);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("posts to Telegram with the bot token in the URL and the exact body", async () => {
    const fetch = fetchMock();
    const notifier = createNotifier({
      config: TELEGRAM_CONFIG,
      env: { BOT_TOKEN },
      fetch,
      logError,
    });

    await notifier.notify(READY);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, init] = fetch.mock.calls[0] ?? [];
    expect(target).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toStrictEqual({ "Content-Type": "application/json" });
    expect(init?.body).toBe(
      JSON.stringify({
        chat_id: "-1001234567890",
        text: "Session done\nAll tests pass",
        disable_web_page_preview: true,
      }),
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not call fetch and logs when the Telegram token is not resolved", async () => {
    const fetch = fetchMock();
    const notifier = createNotifier({
      config: TELEGRAM_CONFIG,
      env: {},
      fetch,
      logError,
    });

    await notifier.notify(ERROR);

    expect(fetch).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("notifications: the Telegram bot token is not set");
  });

  it("logs the HTTP status on a failed answer and never the token", async () => {
    const ntfyFetch = fetchMock(() => new Response("denied", { status: 500 }));
    await createNotifier({
      config: NTFY_CONFIG,
      env: { NTFY_TOKEN },
      fetch: ntfyFetch,
      logError,
    }).notify(ERROR);

    const telegramFetch = fetchMock(() => new Response("denied", { status: 500 }));
    await createNotifier({
      config: TELEGRAM_CONFIG,
      env: { BOT_TOKEN },
      fetch: telegramFetch,
      logError,
    }).notify(ERROR);

    expect(logError).toHaveBeenCalledWith("notifications: ntfy answered HTTP 500");
    expect(logError).toHaveBeenCalledWith("notifications: telegram answered HTTP 500");
    for (const [message] of logError.mock.calls) {
      expect(message).not.toContain(NTFY_TOKEN);
      expect(message).not.toContain(BOT_TOKEN);
    }
  });

  it("logs a generic message when fetch rejects, without the error message", async () => {
    const fetch = fetchMock(() => {
      throw new Error(
        `getaddrinfo failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      );
    });
    const notifier = createNotifier({
      config: TELEGRAM_CONFIG,
      env: { BOT_TOKEN },
      fetch,
      logError,
    });

    await expect(notifier.notify(ERROR)).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith("notifications: telegram request failed");
    expect(logError.mock.calls.flat().join("\n")).not.toContain(BOT_TOKEN);
  });

  it("logs request failed on timeout and resolves", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "TimeoutError"));
          });
        }),
    );
    const notifier = createNotifier({
      config: NTFY_CONFIG,
      env: {},
      fetch,
      logError,
      timeoutMs: 50,
    });

    await expect(notifier.notify(READY)).resolves.toBeUndefined();

    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(logError).toHaveBeenCalledWith("notifications: ntfy request failed");
  });
});

describe("loadNotificationsConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cna-notifier-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when the file is missing", async () => {
    await expect(loadNotificationsConfig(join(dir, "notifications.yaml"))).resolves.toBeUndefined();
  });

  it("parses a valid file", async () => {
    const path = join(dir, "notifications.yaml");
    await writeFile(
      path,
      "provider: ntfy\nevents: [error]\nntfy:\n  url: https://ntfy.example.com\n  topic: cna-alerts\n",
    );

    await expect(loadNotificationsConfig(path)).resolves.toStrictEqual({
      provider: "ntfy",
      events: ["error"],
      ntfy: { url: "https://ntfy.example.com", topic: "cna-alerts" },
    });
  });

  it("rejects an invalid file with a message that names notifications.yaml", async () => {
    const path = join(dir, "notifications.yaml");
    await writeFile(path, "provider: pigeon\n");

    await expect(loadNotificationsConfig(path)).rejects.toThrow(/^notifications\.yaml:/);
  });
});

describe("notificationSecrets", () => {
  it("returns the resolved values and omits the unresolved ones", () => {
    const config = parseNotificationsConfig(
      [
        "provider: telegram",
        "telegram:",
        "  botToken: $BOT_TOKEN",
        "  chatId: '-1001234567890'",
      ].join("\n"),
    );
    expect(notificationSecrets(config, { BOT_TOKEN })).toStrictEqual([BOT_TOKEN]);
    expect(notificationSecrets(config, {})).toStrictEqual([]);

    const literal = parseNotificationsConfig(
      [
        "provider: ntfy",
        "ntfy:",
        "  url: https://ntfy.example.com",
        "  topic: cna-alerts",
        "  token: literal-token",
      ].join("\n"),
    );
    expect(notificationSecrets(literal, {})).toStrictEqual(["literal-token"]);

    const withVariable = parseNotificationsConfig(
      [
        "provider: ntfy",
        "ntfy:",
        "  url: https://ntfy.example.com",
        "  topic: cna-alerts",
        "  token: $NTFY_TOKEN",
      ].join("\n"),
    );
    expect(notificationSecrets(withVariable, { NTFY_TOKEN })).toStrictEqual([NTFY_TOKEN]);
    expect(notificationSecrets(withVariable, {})).toStrictEqual([]);
  });
});
