import { describe, expect, it } from "vitest";
import { SseParser, type SseRecord } from "../src/client/sse.js";

/** Feeds the chunks one by one and returns all records in order. */
function parseChunks(...chunks: string[]): SseRecord[] {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe("SseParser", () => {
  it("parses a simple event", () => {
    expect(parseChunks('id: 3\nevent: status\ndata: {"a":1}\n\n')).toEqual([
      { kind: "event", id: "3", event: "status", data: '{"a":1}' },
    ]);
  });

  it("joins multi-line data with newlines", () => {
    expect(parseChunks("data: one\ndata: two\n\n")).toEqual([{ kind: "event", data: "one\ntwo" }]);
  });

  it("accepts CRLF terminators", () => {
    expect(parseChunks("event: a\r\ndata: x\r\n\r\n")).toEqual([
      { kind: "event", event: "a", data: "x" },
    ]);
  });

  it("accepts bare CR terminators", () => {
    expect(parseChunks("data: x\r\rdata: y\r\r")).toEqual([
      { kind: "event", data: "x" },
      { kind: "event", data: "y" },
    ]);
  });

  it("does not produce an extra empty line when CRLF is split across chunks", () => {
    expect(parseChunks("data: x\r", "\ndata: y\n\n")).toEqual([{ kind: "event", data: "x\ny" }]);
  });

  it("does not split a line in the middle of a word across chunks", () => {
    expect(parseChunks("data: hel", "lo wo", "rld\n\n")).toEqual([
      { kind: "event", data: "hello world" },
    ]);
  });

  it("ignores a leading BOM", () => {
    expect(parseChunks("\uFEFFdata: x\n\n")).toEqual([{ kind: "event", data: "x" }]);
  });

  it("ignores a BOM alone in the first chunk", () => {
    expect(parseChunks("\uFEFF", "data: x\n\n")).toEqual([{ kind: "event", data: "x" }]);
  });

  it("returns comments in order with the event records", () => {
    expect(parseChunks(": ping\ndata: a\n\n: truncated\n\n")).toEqual([
      { kind: "comment", text: "ping" },
      { kind: "event", data: "a" },
      { kind: "comment", text: "truncated" },
    ]);
  });

  it("returns the comment text without the first space only", () => {
    expect(parseChunks(":  two\n")).toEqual([{ kind: "comment", text: " two" }]);
  });

  it("removes only one leading space of a value", () => {
    expect(parseChunks("data:  x\n\n")).toEqual([{ kind: "event", data: " x" }]);
  });

  it("discards an event without data", () => {
    expect(parseChunks("event: x\nid: 4\n\n")).toEqual([]);
  });

  it("does not keep fields of a discarded event", () => {
    expect(parseChunks("event: x\n\ndata: y\n\n")).toEqual([{ kind: "event", data: "y" }]);
  });

  it("treats a line without colon as a field with an empty value", () => {
    expect(parseChunks("data\n\n")).toEqual([{ kind: "event", data: "" }]);
  });

  it("ignores an id containing U+0000", () => {
    expect(parseChunks("id: a\u0000b\ndata: x\n\n")).toEqual([{ kind: "event", data: "x" }]);
  });

  it("does not split data on U+2028 or U+2029", () => {
    expect(parseChunks("data: a\u2028b\u2029c\n\n")).toEqual([
      { kind: "event", data: "a\u2028b\u2029c" },
    ]);
  });

  it("ignores unknown fields and retry", () => {
    expect(parseChunks("retry: 1000\nfoo: bar\ndata: x\n\n")).toEqual([
      { kind: "event", data: "x" },
    ]);
  });

  it("keeps an incomplete record until its terminator arrives", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ kind: "event", data: "x" }]);
  });
});
