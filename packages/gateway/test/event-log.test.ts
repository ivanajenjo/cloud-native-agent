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
