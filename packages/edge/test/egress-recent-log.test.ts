import type { NetworkLogEntry } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { createRecentNetworkLog } from "../src/egress/recent-log.js";

function entry(n: number): NetworkLogEntry {
  return {
    ts: new Date(Date.UTC(2026, 10, 16, 0, 0, n)).toISOString(),
    method: "CONNECT",
    host: `host-${n}.example`,
    port: 443,
    decision: "allow",
    reason: "allowlist",
    bytesOut: n,
    bytesIn: n * 2,
    durationMs: n,
  };
}

describe("createRecentNetworkLog", () => {
  it("returns nothing when empty", () => {
    expect(createRecentNetworkLog(3).list(10)).toEqual([]);
  });

  it("keeps at most capacity entries and drops the oldest", () => {
    const log = createRecentNetworkLog(3);
    for (let n = 1; n <= 5; n++) log.append(entry(n));
    expect(log.list(100).map((e) => e.host)).toEqual([
      "host-3.example",
      "host-4.example",
      "host-5.example",
    ]);
  });

  it("list(limit) returns the most recent entries, oldest first", () => {
    const log = createRecentNetworkLog(5);
    for (let n = 1; n <= 4; n++) log.append(entry(n));
    expect(log.list(2).map((e) => e.host)).toEqual(["host-3.example", "host-4.example"]);
    expect(log.list(1).map((e) => e.host)).toEqual(["host-4.example"]);
  });

  it("list(limit) larger than the content returns everything", () => {
    const log = createRecentNetworkLog(10);
    log.append(entry(1));
    log.append(entry(2));
    expect(log.list(200).map((e) => e.host)).toEqual(["host-1.example", "host-2.example"]);
  });

  it("list(0) returns an empty array", () => {
    const log = createRecentNetworkLog(2);
    log.append(entry(1));
    expect(log.list(0)).toEqual([]);
  });

  it("keeps the order after the buffer wrapped more than once", () => {
    const log = createRecentNetworkLog(2);
    for (let n = 1; n <= 7; n++) log.append(entry(n));
    expect(log.list(2).map((e) => e.host)).toEqual(["host-6.example", "host-7.example"]);
  });

  it("stores copies: mutating the original object does not change the buffer", () => {
    const log = createRecentNetworkLog(2);
    const original = entry(1);
    log.append(original);
    original.host = "changed.example";
    original.decision = "deny";
    expect(log.list(1)[0]).toEqual(entry(1));
  });

  it("returned objects are copies too", () => {
    const log = createRecentNetworkLog(2);
    log.append(entry(1));
    const [first] = log.list(1);
    if (first !== undefined) first.host = "changed.example";
    expect(log.list(1)[0]?.host).toBe("host-1.example");
  });

  it("rejects a capacity that is not a positive integer", () => {
    expect(() => createRecentNetworkLog(0)).toThrow(RangeError);
    expect(() => createRecentNetworkLog(1.5)).toThrow(RangeError);
  });
});
