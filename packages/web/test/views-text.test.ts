import { describe, expect, it } from "vitest";
import {
  clip,
  expiryTime,
  formatToolDuration,
  prettyJson,
  summarizeArgs,
} from "../src/views/text.js";

describe("summarizeArgs", () => {
  it("serializes a short object as JSON", () => {
    expect(summarizeArgs({ path: "a.txt" })).toBe('{"path":"a.txt"}');
  });

  it("clips a long value to 120 code points and adds an ellipsis", () => {
    const summary = summarizeArgs({ text: "x".repeat(500) });
    expect(summary.endsWith("…")).toBe(true);
    expect(Array.from(summary.slice(0, -1))).toHaveLength(120);
    expect(summary.slice(0, 120)).toBe(JSON.stringify({ text: "x".repeat(500) }).slice(0, 120));
  });

  it("returns an empty string for circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeArgs(circular)).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(summarizeArgs(undefined)).toBe("");
  });
});

describe("prettyJson", () => {
  it("indents an object with two spaces", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back to String(value) for circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toBe("[object Object]");
  });

  it("falls back to String(value) for undefined", () => {
    expect(prettyJson(undefined)).toBe("undefined");
  });
});

describe("clip", () => {
  it("keeps a short text untouched", () => {
    expect(clip("hola", 10)).toEqual({ text: "hola", clipped: false });
  });

  it("cuts a long text to the first max code points", () => {
    expect(clip("abcdef", 3)).toEqual({ text: "abc", clipped: true });
  });

  it("does not split an emoji (surrogate pair) at the limit", () => {
    // "😀" is two UTF-16 units but one code point.
    expect(clip("a😀b", 2)).toEqual({ text: "a😀", clipped: true });
    expect(clip("ab😀", 2)).toEqual({ text: "ab", clipped: true });
    expect(clip("😀", 1)).toEqual({ text: "😀", clipped: false });
  });
});

describe("formatToolDuration", () => {
  it("formats 0 ms", () => {
    expect(formatToolDuration(0)).toBe("0 ms");
  });

  it("formats values below one second in milliseconds", () => {
    expect(formatToolDuration(999)).toBe("999 ms");
  });

  it("formats one second in seconds with one decimal", () => {
    expect(formatToolDuration(1000)).toBe("1.0 s");
  });

  it("rounds 1250 ms to one decimal", () => {
    expect(formatToolDuration(1250)).toBe("1.3 s");
  });
});

describe("expiryTime", () => {
  it("returns the local HH:MM:SS of createdAt plus the timeout", () => {
    const createdAt = "2026-11-17T10:00:00.000Z";
    const expected = new Date(Date.parse(createdAt) + 90_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = `${pad(expected.getHours())}:${pad(expected.getMinutes())}:${pad(expected.getSeconds())}`;
    expect(expiryTime(createdAt, 90_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(expiryTime(createdAt, 90_000)).toBe(time);
  });

  it("returns an empty string for an invalid createdAt", () => {
    expect(expiryTime("no es una fecha", 1000)).toBe("");
  });
});
