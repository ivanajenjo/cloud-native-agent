import { describe, expect, it } from "vitest";
import {
  ApiClient,
  ApiClientError,
  type EventStreamItem,
  followEvents,
} from "../src/client/index.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that records the calls and answers with `respond`. */
function fakeFetch(respond: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function header(call: RecordedCall, name: string): string | null {
  return new Headers(call.init?.headers).get(name);
}

/** An SSE answer whose body is made of the given byte chunks. */
function sseResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function sseText(text: string): Response {
  return sseResponse([new TextEncoder().encode(text)]);
}

function streamEventRecord(id: number, message = "hi"): string {
  const event = { id, ts: "2026-01-01T00:00:00.000Z", event: { type: "error", message } };
  return `id: ${id}\nevent: error\ndata: ${JSON.stringify(event)}\n\n`;
}

const SESSION = {
  id: "s1",
  status: "idle",
  repo: "octo/hello",
  baseBranch: null,
  branch: null,
  model: null,
  thinking: null,
  mode: "auto",
  autoPush: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  pendingQuestions: [],
};

describe("ApiClient headers and URLs", () => {
  it("sends the bearer token when non-empty", async () => {
    const fake = fakeFetch(() => json(SESSION));
    const client = new ApiClient({ baseUrl: "http://h:1", token: "secret", fetch: fake.fetch });
    await client.getSession();
    expect(header(fake.calls[0] as RecordedCall, "authorization")).toBe("Bearer secret");
  });

  it("sends no authorization header without token", async () => {
    const fake = fakeFetch(() => json(SESSION));
    const client = new ApiClient({ baseUrl: "http://h:1", fetch: fake.fetch });
    await client.getSession();
    expect(header(fake.calls[0] as RecordedCall, "authorization")).toBeNull();
  });

  it("removes trailing slashes of baseUrl", async () => {
    const fake = fakeFetch(() => json(SESSION));
    const client = new ApiClient({ baseUrl: "http://h:1//", fetch: fake.fetch });
    await client.getSession();
    expect(fake.calls[0]?.url).toBe("http://h:1/session");
  });

  it("uses relative URLs with an empty baseUrl", async () => {
    const fake = fakeFetch(() => json(SESSION));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.getSession();
    expect(fake.calls[0]?.url).toBe("/session");
  });

  it("sends JSON bodies with content-type application/json", async () => {
    const fake = fakeFetch(() => json(SESSION, 201));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const created = await client.createSession({ repo: "octo/hello", prompt: "hi" });
    expect(created).toEqual(SESSION);
    const call = fake.calls[0] as RecordedCall;
    expect(call.init?.method).toBe("POST");
    expect(header(call, "content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({ repo: "octo/hello", prompt: "hi" });
  });
});

describe("ApiClient errors", () => {
  it("returns null for getSession on 404", async () => {
    const client = new ApiClient({
      baseUrl: "",
      fetch: fakeFetch(() => json({ error: "no_session" }, 404)).fetch,
    });
    await expect(client.getSession()).resolves.toBeNull();
  });

  it("throws ApiClientError with the API error code and message", async () => {
    const client = new ApiClient({
      baseUrl: "",
      fetch: fakeFetch(() => json({ error: "session_exists", message: "busy" }, 409)).fetch,
    });
    const error = await client
      .createSession({ repo: "octo/hello", prompt: "hi" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, code: "session_exists", message: "busy" });
  });

  it("uses code unknown and HTTP status message for a non-JSON body", async () => {
    const client = new ApiClient({
      baseUrl: "",
      fetch: fakeFetch(() => new Response("<html>boom</html>", { status: 500 })).fetch,
    });
    await expect(client.models()).rejects.toMatchObject({
      status: 500,
      code: "unknown",
      message: "HTTP 500",
    });
  });

  it("uses HTTP status message when the body has no message", async () => {
    const client = new ApiClient({
      baseUrl: "",
      fetch: fakeFetch(() => json({ error: "not_found" }, 404)).fetch,
    });
    await expect(client.todos()).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "HTTP 404",
    });
  });

  it("maps a fetch failure to status 0 network_error", async () => {
    const client = new ApiClient({
      baseUrl: "",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch,
    });
    await expect(client.abort()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      message: "fetch failed",
    });
  });
});

describe("ApiClient endpoints", () => {
  it("encodes the question id in answer", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.answer("a/b", { value: "x" });
    expect(fake.calls[0]?.url).toBe("/session/answers/a%2Fb");
    expect(fake.calls[0]?.init?.method).toBe("POST");
  });

  it("uses ?force=true when closing with force", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.closeSession({ force: true });
    expect(fake.calls[0]?.url).toBe("/session?force=true");
    expect(fake.calls[0]?.init?.method).toBe("DELETE");
  });

  it("uses no query when closing without force", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.closeSession();
    expect(fake.calls[0]?.url).toBe("/session");
  });

  it("uses ?checkpoint= for diff", async () => {
    const fake = fakeFetch(() => json({ from: null, files: [], patch: "", truncated: false }));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.diff(3);
    expect(fake.calls[0]?.url).toBe("/session/diff?checkpoint=3");
  });

  it("uses no query for diff without checkpoint", async () => {
    const fake = fakeFetch(() => json({ from: null, files: [], patch: "", truncated: false }));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.diff();
    expect(fake.calls[0]?.url).toBe("/session/diff");
  });

  it("sends {} when restoring a checkpoint without body", async () => {
    const fake = fakeFetch(() =>
      json({
        checkpoint: { id: 2, commit: "abc", createdAt: "2026-01-01T00:00:00.000Z", reason: "run" },
        conversationRestored: false,
      }),
    );
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await client.restoreCheckpoint(2);
    const call = fake.calls[0] as RecordedCall;
    expect(call.url).toBe("/session/checkpoints/2/restore");
    expect(call.init?.body).toBe("{}");
  });

  it("unwraps messages, todos, checkpoints and network log", async () => {
    const fake = fakeFetch((call) => {
      if (call.url.endsWith("/session/messages")) return json({ messages: [{ role: "user" }] });
      if (call.url.endsWith("/session/todos")) return json({ todos: [] });
      if (call.url.endsWith("/session/checkpoints")) return json({ checkpoints: [] });
      return json({ entries: [] });
    });
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    await expect(client.messages()).resolves.toEqual([{ role: "user" }]);
    await expect(client.todos()).resolves.toEqual([]);
    await expect(client.checkpoints()).resolves.toEqual([]);
    await expect(client.networkLog(5)).resolves.toEqual([]);
    expect(fake.calls[3]?.url).toBe("/network/log?limit=5");
  });
});

describe("ApiClient.events", () => {
  it("parses events from chunks split inside a multibyte UTF-8 character", async () => {
    const payload = `${streamEventRecord(1, "héllo")}${streamEventRecord(2)}`;
    const bytes = new TextEncoder().encode(payload);
    const splitAt = bytes.indexOf(0xc3) + 1;
    const fake = fakeFetch(() =>
      sseResponse([
        bytes.slice(0, splitAt),
        bytes.slice(splitAt, splitAt + 40),
        bytes.slice(splitAt + 40),
      ]),
    );
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const items: EventStreamItem[] = [];
    for await (const item of client.events()) items.push(item);
    expect(items).toEqual([
      {
        kind: "event",
        event: {
          id: 1,
          ts: "2026-01-01T00:00:00.000Z",
          event: { type: "error", message: "héllo" },
        },
      },
      {
        kind: "event",
        event: { id: 2, ts: "2026-01-01T00:00:00.000Z", event: { type: "error", message: "hi" } },
      },
    ]);
  });

  it("sends Accept and Last-Event-ID", async () => {
    const fake = fakeFetch(() => sseText(""));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    for await (const _item of client.events({ lastEventId: 7 })) {
      // no items
    }
    const call = fake.calls[0] as RecordedCall;
    expect(call.url).toBe("/session/events");
    expect(header(call, "accept")).toBe("text/event-stream");
    expect(header(call, "last-event-id")).toBe("7");
  });

  it("does not send Last-Event-ID without a previous id", async () => {
    const fake = fakeFetch(() => sseText(""));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    for await (const _item of client.events()) {
      // no items
    }
    expect(header(fake.calls[0] as RecordedCall, "last-event-id")).toBeNull();
  });

  it("skips records whose data is not JSON and yields truncated", async () => {
    const text = `: ping\ndata: not json\n\n: truncated\n\n${streamEventRecord(4)}`;
    const client = new ApiClient({ baseUrl: "", fetch: fakeFetch(() => sseText(text)).fetch });
    const items: EventStreamItem[] = [];
    for await (const item of client.events()) items.push(item);
    expect(items.map((item) => item.kind)).toEqual(["truncated", "event"]);
  });

  it("skips JSON that is not a stream event", async () => {
    const text = 'data: {"id":"x","event":{"type":"error"}}\n\ndata: [1]\n\n';
    const client = new ApiClient({ baseUrl: "", fetch: fakeFetch(() => sseText(text)).fetch });
    const items: EventStreamItem[] = [];
    for await (const item of client.events()) items.push(item);
    expect(items).toEqual([]);
  });

  it("throws ApiClientError before yielding on a non-2xx answer", async () => {
    const client = new ApiClient({
      baseUrl: "",
      fetch: fakeFetch(() => json({ error: "unauthorized" }, 401)).fetch,
    });
    const iterator = client.events();
    await expect(iterator.next()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("ends silently when the signal aborts while waiting for data", async () => {
    const controller = new AbortController();
    const hanging = new ReadableStream<Uint8Array>({ start() {} });
    const client = new ApiClient({
      baseUrl: "",
      fetch: fakeFetch(() => new Response(hanging, { status: 200 })).fetch,
    });
    const items: EventStreamItem[] = [];
    setTimeout(() => controller.abort(), 5);
    for await (const item of client.events({ signal: controller.signal })) items.push(item);
    expect(items).toEqual([]);
  });

  it("ends silently when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeFetch(() => sseText(streamEventRecord(1)));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const items: EventStreamItem[] = [];
    for await (const item of client.events({ signal: controller.signal })) items.push(item);
    expect(items).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("followEvents", () => {
  it("reconnects with Last-Event-ID set to the last id seen", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => {
      if (fake.calls.length === 1) return sseText(streamEventRecord(1) + streamEventRecord(2));
      return sseText(streamEventRecord(3));
    });
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const ids: number[] = [];
    for await (const item of followEvents(client, {
      signal: controller.signal,
      retryDelayMs: 0,
    })) {
      if (item.kind === "event") ids.push(item.event.id);
      if (ids.length === 3) controller.abort();
    }
    expect(ids).toEqual([1, 2, 3]);
    expect(fake.calls).toHaveLength(2);
    expect(header(fake.calls[1] as RecordedCall, "last-event-id")).toBe("2");
  });

  it("yields reset when the first event after reconnect has a lower id", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => {
      if (fake.calls.length === 1) return sseText(streamEventRecord(5));
      return sseText(streamEventRecord(1) + streamEventRecord(2));
    });
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const kinds: string[] = [];
    for await (const item of followEvents(client, {
      signal: controller.signal,
      retryDelayMs: 0,
    })) {
      kinds.push(item.kind === "event" ? `event:${item.event.id}` : item.kind);
      if (kinds.length === 4) controller.abort();
    }
    expect(kinds).toEqual(["event:5", "reset", "event:1", "event:2"]);
  });

  it("does not yield reset when ids keep growing after reconnect", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => {
      if (fake.calls.length === 1) return sseText(streamEventRecord(1));
      return sseText(streamEventRecord(2));
    });
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const kinds: string[] = [];
    for await (const item of followEvents(client, {
      signal: controller.signal,
      retryDelayMs: 0,
    })) {
      kinds.push(item.kind === "event" ? `event:${item.event.id}` : item.kind);
      if (kinds.length === 2) controller.abort();
    }
    expect(kinds).toEqual(["event:1", "event:2"]);
  });

  it("rethrows a 401 without retrying", async () => {
    const fake = fakeFetch(() => json({ error: "unauthorized" }, 401));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    const iterator = followEvents(client, { retryDelayMs: 0 });
    await expect(iterator.next()).rejects.toMatchObject({ status: 401 });
    expect(fake.calls).toHaveLength(1);
  });

  it("reports disconnections and keeps retrying on other errors", async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const fake = fakeFetch(() => {
      if (fake.calls.length === 1) return json({ error: "internal_error" }, 500);
      return sseText(streamEventRecord(1));
    });
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    for await (const item of followEvents(client, {
      signal: controller.signal,
      retryDelayMs: 0,
      onDisconnect: (error) => errors.push(error),
    })) {
      if (item.kind === "event") controller.abort();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ApiClientError);
  });

  it("stops when the signal aborts during the wait before reconnecting", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(() => sseText(""));
    const client = new ApiClient({ baseUrl: "", fetch: fake.fetch });
    setTimeout(() => controller.abort(), 5);
    const items: EventStreamItem[] = [];
    for await (const item of followEvents(client, {
      signal: controller.signal,
      retryDelayMs: 60_000,
    })) {
      items.push(item);
    }
    expect(items).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
});
