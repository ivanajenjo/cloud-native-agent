import type { SessionEvent } from "@cna/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog, type ReplayResult } from "../src/events/event-log.js";
import { createSseResponse, formatSseRecord, parseLastEventId } from "../src/events/sse.js";

const notify = (message: string): SessionEvent => ({ type: "notify", level: "info", message });

const decoder = new TextDecoder();

/** Reads chunks from the body until `done(text)` holds or the stream ends. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
): Promise<string> {
  let text = "";
  while (!done(text)) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

/** Ids of the SSE records found in `text`, in order. */
function recordIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLastEventId", () => {
  it.each([
    [undefined, 0],
    ["5", 5],
    ["0", 0],
    ["-1", 0],
    ["abc", 0],
    ["1.5", 0],
    [" 3", 0],
    ["", 0],
    ["99999999999999999999", 0],
  ])("parses %j as %i", (header, expected) => {
    expect(parseLastEventId(header)).toBe(expected);
  });
});

describe("formatSseRecord", () => {
  it("formats one record exactly", () => {
    const record = formatSseRecord({
      id: 7,
      ts: "2026-01-02T03:04:05.000Z",
      event: { type: "error", message: "boom" },
    });

    expect(record).toBe(
      'id: 7\nevent: error\ndata: {"id":7,"ts":"2026-01-02T03:04:05.000Z","event":{"type":"error","message":"boom"}}\n\n',
    );
  });

  it("keeps data on one line even when the text has newlines and U+2028", () => {
    const record = formatSseRecord({
      id: 1,
      ts: "2026-01-02T03:04:05.000Z",
      event: notify("line one\nline two\r\nthree four"),
    });

    // Lines: id, event, data, blank terminator, and the empty string after the final "\n".
    const lines = record.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("id: 1");
    expect(lines[1]).toBe("event: notify");
    expect(lines[2]?.startsWith("data: {")).toBe(true);
    expect(lines[2]).toContain(" ");
    expect(lines[3]).toBe("");
  });
});

describe("createSseResponse headers", () => {
  it("answers 200 with the SSE headers", () => {
    const log = new EventLog();
    const res = createSseResponse(log, 0, new AbortController().signal);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });
});

describe("createSseResponse replay and live events", () => {
  it("replays the events after lastEventId and then streams live ones", async () => {
    const log = new EventLog();
    log.append(notify("1"));
    log.append(notify("2"));
    log.append(notify("3"));
    const ac = new AbortController();
    const res = createSseResponse(log, 1, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    const replayed = await readUntil(reader, (text) => recordIds(text).includes(3));
    log.append(notify("4"));
    const live = await readUntil(reader, (text) => recordIds(text).includes(4));

    expect(recordIds(replayed)).toEqual([2, 3]);
    expect(recordIds(live)).toEqual([4]);
    expect(live).toContain('"message":"4"');

    ac.abort();
    await reader.cancel();
  });

  it("does not duplicate or lose events appended while the replay is computed", async () => {
    // Appends inside since(), i.e. between the replay read and the write of the replay.
    class AppendingLog extends EventLog {
      private appended = false;

      override since(afterId: number): ReplayResult {
        const result = super.since(afterId);
        if (!this.appended) {
          this.appended = true;
          this.append(notify("during replay"));
        }
        return result;
      }
    }
    const log = new AppendingLog();
    log.append(notify("1"));
    log.append(notify("2"));
    const ac = new AbortController();
    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    const text = await readUntil(reader, (t) => recordIds(t).includes(3));

    expect(recordIds(text)).toEqual([1, 2, 3]);
    ac.abort();
    await reader.cancel();
  });

  it("writes ': truncated' before the replay when events were lost", async () => {
    const log = new EventLog({ capacity: 2 });
    log.append(notify("1"));
    log.append(notify("2"));
    log.append(notify("3"));
    const ac = new AbortController();
    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    const text = await readUntil(reader, (t) => recordIds(t).includes(3));

    expect(text.startsWith(": connected\n\n: truncated\n\n")).toBe(true);
    expect(recordIds(text)).toEqual([2, 3]);
    ac.abort();
    await reader.cancel();
  });

  it("does not write ': truncated' when nothing was lost", async () => {
    const log = new EventLog({ capacity: 5 });
    log.append(notify("1"));
    const ac = new AbortController();
    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    const text = await readUntil(reader, (t) => recordIds(t).includes(1));

    expect(text).not.toContain(": truncated");
    ac.abort();
    await reader.cancel();
  });
});

describe("createSseResponse with a Last-Event-ID from a previous process", () => {
  it("replays the whole buffer when lastEventId is ahead of the log", async () => {
    const log = new EventLog();
    log.append(notify("a"));
    log.append(notify("b"));
    const ac = new AbortController();
    const res = createSseResponse(log, 500, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }
    const text = await readUntil(reader, (t) => t.includes("id: 2\n"));
    ac.abort();
    expect(text).toContain("id: 1\n");
    expect(text).toContain("id: 2\n");
  });
});

describe("createSseResponse abort and cancel", () => {
  it("closes the stream and removes the listener when the signal aborts", async () => {
    const log = new EventLog();
    const ac = new AbortController();
    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }
    expect(log.listenerCount).toBe(1);
    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");

    ac.abort();

    expect((await reader.read()).done).toBe(true);
    expect(log.listenerCount).toBe(0);
    expect(() => log.append(notify("after abort"))).not.toThrow();
  });

  it("closes right away when the signal is already aborted", async () => {
    const log = new EventLog();
    const ac = new AbortController();
    ac.abort();

    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    expect((await reader.read()).done).toBe(true);
    expect(log.listenerCount).toBe(0);
  });

  it("unsubscribes when the client cancels the stream", async () => {
    const log = new EventLog();
    const ac = new AbortController();
    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 60_000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    await reader.cancel();

    expect(log.listenerCount).toBe(0);
    expect(() => log.append(notify("after cancel"))).not.toThrow();
  });
});

describe("createSseResponse heartbeat", () => {
  it("writes ': ping' every heartbeatMs and stops after abort", async () => {
    vi.useFakeTimers();
    const log = new EventLog();
    const ac = new AbortController();
    const res = createSseResponse(log, 0, ac.signal, { heartbeatMs: 1000 });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("missing body");
    }

    expect(decoder.decode((await reader.read()).value)).toBe(": connected\n\n");
    vi.advanceTimersByTime(1000);
    const first = await reader.read();

    expect(decoder.decode(first.value)).toBe(": ping\n\n");

    ac.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect((await reader.read()).done).toBe(true);
  });
});
