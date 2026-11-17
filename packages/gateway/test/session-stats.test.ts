import { describe, expect, it } from "vitest";
import { parseSessionStats } from "../src/session/stats.js";

/** The data of Pi's get_session_stats response example (docs/rpc-commands.md). */
const piExample = {
  sessionFile: "/path/to/session.jsonl",
  sessionId: "abc123",
  userMessages: 5,
  assistantMessages: 5,
  toolCalls: 12,
  toolResults: 12,
  totalMessages: 22,
  tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
  cost: 0.45,
  contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
};

describe("parseSessionStats", () => {
  it("translates the example of Pi's documentation", () => {
    expect(parseSessionStats(piExample)).toStrictEqual({
      tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
      cost: 0.45,
      messages: { user: 5, assistant: 5, toolCalls: 12 },
      context: { tokens: 60000, window: 200000, percent: 30 },
    });
  });

  it("returns context null when contextUsage is absent", () => {
    const { contextUsage: _ignored, ...data } = piExample;

    expect(parseSessionStats(data)?.context).toBeNull();
    expect(parseSessionStats({ ...piExample, contextUsage: null })?.context).toBeNull();
  });

  it("keeps tokens and percent null when Pi sends null", () => {
    const stats = parseSessionStats({
      ...piExample,
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    });

    expect(stats?.context).toStrictEqual({ tokens: null, window: 200000, percent: null });
  });

  it("returns context null when contextWindow is not a number", () => {
    expect(
      parseSessionStats({ ...piExample, contextUsage: { tokens: 1, percent: 1 } })?.context,
    ).toBeNull();
    expect(
      parseSessionStats({ ...piExample, contextUsage: { contextWindow: "200000" } })?.context,
    ).toBeNull();
  });

  it("counts missing or non-number messages as 0", () => {
    const stats = parseSessionStats({ tokens: piExample.tokens, cost: 0, toolCalls: "many" });

    expect(stats?.messages).toStrictEqual({ user: 0, assistant: 0, toolCalls: 0 });
  });

  it("returns null without the five token numbers", () => {
    const { input: _input, ...partial } = piExample.tokens;

    expect(parseSessionStats({ ...piExample, tokens: partial })).toBeNull();
    expect(parseSessionStats({ ...piExample, tokens: undefined })).toBeNull();
    expect(parseSessionStats({ ...piExample, tokens: 105000 })).toBeNull();
  });

  it("returns null when cost is not a number", () => {
    expect(parseSessionStats({ ...piExample, cost: "0.45" })).toBeNull();
    expect(parseSessionStats({ ...piExample, cost: undefined })).toBeNull();
  });

  it("returns null for values that are not an object", () => {
    for (const data of [null, undefined, [], [piExample], 42, "stats", true]) {
      expect(parseSessionStats(data)).toBeNull();
    }
  });

  it("treats NaN and Infinity as missing", () => {
    expect(parseSessionStats({ ...piExample, cost: Number.NaN })).toBeNull();
    expect(
      parseSessionStats({ ...piExample, tokens: { ...piExample.tokens, total: Number.NaN } }),
    ).toBeNull();
    expect(
      parseSessionStats({
        ...piExample,
        contextUsage: { tokens: Number.NaN, contextWindow: Number.POSITIVE_INFINITY, percent: 1 },
      })?.context,
    ).toBeNull();
    expect(
      parseSessionStats({
        ...piExample,
        contextUsage: { tokens: Number.NaN, contextWindow: 200000, percent: Number.NaN },
      })?.context,
    ).toStrictEqual({ tokens: null, window: 200000, percent: null });
  });

  it("never throws on odd input", () => {
    const odd = [
      { tokens: null },
      { tokens: [], cost: 1 },
      { ...piExample, contextUsage: [] },
      { ...piExample, contextUsage: 3 },
    ];

    for (const data of odd) {
      expect(() => parseSessionStats(data)).not.toThrow();
    }
    expect(parseSessionStats(odd[2])?.context).toBeNull();
  });
});
