import type { SessionEvent } from "@cna/shared";
import { describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/events/event-log.js";

const notify = (message: string): SessionEvent => ({ type: "notify", level: "info", message });

describe("EventLog ids and timestamps", () => {
  it("assigns ids starting at 1 and growing", () => {
    const log = new EventLog();

    const first = log.append(notify("a"));
    const second = log.append(notify("b"));

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(first.event).toEqual(notify("a"));
    expect(log.lastId).toBe(2);
  });

  it("takes ts from the injected clock", () => {
    const instant = new Date("2026-01-02T03:04:05.678Z");
    const log = new EventLog({ now: () => instant });

    const stored = log.append(notify("a"));

    expect(stored.ts).toBe("2026-01-02T03:04:05.678Z");
  });

  it("reports lastId 0 when empty", () => {
    expect(new EventLog().lastId).toBe(0);
  });

  it("rejects a capacity that is not a positive integer", () => {
    expect(() => new EventLog({ capacity: 0 })).toThrow(RangeError);
    expect(() => new EventLog({ capacity: 1.5 })).toThrow(RangeError);
  });
});

describe("EventLog.since", () => {
  it("returns the whole buffer for afterId 0", () => {
    const log = new EventLog();
    log.append(notify("a"));
    log.append(notify("b"));

    const result = log.since(0);

    expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
  });

  it("returns only the events after afterId", () => {
    const log = new EventLog();
    log.append(notify("a"));
    log.append(notify("b"));
    log.append(notify("c"));

    expect(log.since(1).events.map((e) => e.id)).toEqual([2, 3]);
    expect(log.since(3).events).toEqual([]);
  });

  it("is truncated only when events were dropped by capacity", () => {
    const log = new EventLog({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      log.append(notify(String(i)));
    }

    const all = log.since(0);
    expect(all.events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(all.truncated).toBe(true);
    expect(log.since(2).truncated).toBe(false);
    expect(log.since(2).events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(log.since(1).truncated).toBe(true);
  });

  it("is never truncated when nothing was dropped", () => {
    const log = new EventLog({ capacity: 5 });
    for (let i = 0; i < 5; i++) {
      log.append(notify(String(i)));
    }

    expect(log.since(0).truncated).toBe(false);
    expect(log.since(1).truncated).toBe(false);
  });
});

describe("EventLog.subscribe", () => {
  it("delivers events to listeners in subscription order", () => {
    const log = new EventLog();
    const calls: string[] = [];
    log.subscribe(() => calls.push("first"));
    log.subscribe(() => calls.push("second"));

    log.append(notify("a"));

    expect(calls).toEqual(["first", "second"]);
  });

  it("stops delivering after unsubscribe", () => {
    const log = new EventLog();
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);

    log.append(notify("a"));
    unsubscribe();
    log.append(notify("b"));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.listenerCount).toBe(0);
  });

  it("keeps notifying the next listener when one throws, and append still works", () => {
    const log = new EventLog();
    const after = vi.fn();
    log.subscribe(() => {
      throw new Error("boom");
    });
    log.subscribe(after);

    const stored = log.append(notify("a"));

    expect(after).toHaveBeenCalledWith(stored);
    expect(log.since(0).events).toEqual([stored]);
  });
});

describe("EventLog firstId", () => {
  it("starts the ids at firstId and keeps growing", () => {
    const log = new EventLog({ firstId: 1000 });

    expect(log.append(notify("a")).id).toBe(1000);
    expect(log.append(notify("b")).id).toBe(1001);
    expect(log.lastId).toBe(1001);
  });

  it("reports lastId 0 when empty, even with firstId", () => {
    expect(new EventLog({ firstId: 1000 }).lastId).toBe(0);
  });

  it("keeps growing from firstId after clear", () => {
    const log = new EventLog({ firstId: 1000 });
    log.append(notify("a"));
    log.append(notify("b"));

    log.clear();

    expect(log.append(notify("c")).id).toBe(1002);
    expect(log.since(0).events.map((e) => e.id)).toEqual([1002]);
  });

  it("replays correctly with since(lastId) from a previous process", () => {
    const log = new EventLog({ firstId: Date.now() });
    const first = log.append(notify("a"));
    const second = log.append(notify("b"));

    expect(log.since(first.id).events).toEqual([second]);
    expect(log.since(second.id).events).toEqual([]);
  });

  it("replays the whole buffer to a client whose id is from a previous process", () => {
    const previous = new EventLog({ firstId: 5000 });
    previous.append(notify("old"));
    const lastEventId = previous.lastId;

    const current = new EventLog({ firstId: 9000 });
    const stored = current.append(notify("new"));

    // Lower id than the buffer: everything is replayed.
    expect(lastEventId).toBe(5000);
    expect(current.since(lastEventId).events).toEqual([stored]);
    expect(current.since(lastEventId).truncated).toBe(false);
  });

  it("behaves as before for an afterId greater than the last id", () => {
    const log = new EventLog({ firstId: 1000 });
    log.append(notify("a"));
    log.append(notify("b"));

    expect(log.since(5000)).toEqual({ events: [], truncated: false });
  });

  it("reports truncation with a high firstId when events were dropped by capacity", () => {
    const log = new EventLog({ capacity: 2, firstId: 1000 });
    for (let i = 0; i < 4; i++) {
      log.append(notify(String(i)));
    }

    expect(log.since(0).events.map((e) => e.id)).toEqual([1002, 1003]);
    expect(log.since(0).truncated).toBe(true);
    expect(log.since(1001).truncated).toBe(false);
    expect(log.since(1000).truncated).toBe(true);
  });

  it("rejects a firstId that is not a safe integer >= 1", () => {
    for (const firstId of [0, 1.5, Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new EventLog({ firstId })).toThrow(RangeError);
    }
  });

  it("accepts firstId 1 as the default", () => {
    expect(new EventLog({ firstId: 1 }).append(notify("a")).id).toBe(1);
  });
});

describe("EventLog.clear", () => {
  it("empties the buffer but ids keep growing", () => {
    const log = new EventLog();
    log.append(notify("a"));
    log.append(notify("b"));

    log.clear();

    expect(log.since(0).events).toEqual([]);
    expect(log.lastId).toBe(2);
    expect(log.append(notify("c")).id).toBe(3);
    expect(log.since(0).events.map((e) => e.id)).toEqual([3]);
  });
});
