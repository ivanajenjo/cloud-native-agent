import type { Question, QuestionOutcome } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingQuestions } from "../src/session/pending-questions.js";

function question(id: string, overrides: Partial<Question> = {}): Question {
  return {
    id,
    kind: "ask_user",
    method: "input",
    title: `Question ${id}`,
    createdAt: "2026-11-16T10:00:00.000Z",
    ...overrides,
  };
}

function setup() {
  const resolved: Array<[string, QuestionOutcome]> = [];
  const pending = new PendingQuestions({
    onResolved: (questionId, outcome) => {
      resolved.push([questionId, outcome]);
    },
  });
  return { pending, resolved };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingQuestions", () => {
  it("adds and lists questions in insertion order, with size", () => {
    const { pending } = setup();
    pending.add(question("a"), "pi");
    pending.add(question("b"), "edge");
    pending.add(question("c"), "pi");

    expect(pending.size).toBe(3);
    expect(pending.list().map((q) => q.id)).toEqual(["a", "b", "c"]);
    expect(pending.get("b")).toEqual({ question: question("b"), source: "edge" });
    expect(pending.get("zzz")).toBeUndefined();
  });

  it("throws when adding an id that is already pending", () => {
    const { pending } = setup();
    pending.add(question("a"), "pi");
    expect(() => pending.add(question("a"), "pi")).toThrow();
    expect(pending.size).toBe(1);
  });

  it("resolve calls onResolved once and returns true; a second resolve returns false", () => {
    const { pending, resolved } = setup();
    pending.add(question("a"), "pi");

    expect(pending.resolve("a", "answered")).toBe(true);
    expect(resolved).toEqual([["a", "answered"]]);

    expect(pending.resolve("a", "answered")).toBe(false);
    expect(resolved).toEqual([["a", "answered"]]);
  });

  it("resolves a Pi question with a timeout when its clock runs out", () => {
    const { pending, resolved } = setup();
    pending.add(question("a", { timeoutMs: 1000 }), "pi");

    vi.advanceTimersByTime(999);
    expect(resolved).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(resolved).toEqual([["a", "timeout"]]);
    expect(pending.size).toBe(0);
  });

  it("removes the question before onResolved runs", () => {
    const seen: Array<{ size: number; ids: string[] }> = [];
    const pending = new PendingQuestions({
      onResolved: () => {
        seen.push({ size: pending.size, ids: pending.list().map((q) => q.id) });
      },
    });
    pending.add(question("a"), "pi");
    pending.add(question("b"), "pi");

    pending.resolve("a", "answered");
    expect(seen).toEqual([{ size: 1, ids: ["b"] }]);
  });

  it("resolve before the deadline cancels the timer", () => {
    const { pending, resolved } = setup();
    pending.add(question("a", { timeoutMs: 1000 }), "pi");

    expect(pending.resolve("a", "answered")).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(resolved).toEqual([["a", "answered"]]);
  });

  it("a edge question with timeoutMs arms no timer and stays pending", () => {
    const { pending, resolved } = setup();
    pending.add(question("a", { timeoutMs: 1000 }), "edge");

    vi.advanceTimersByTime(5000);

    expect(resolved).toEqual([]);
    expect(pending.get("a")?.source).toBe("edge");
    expect(pending.size).toBe(1);
  });

  it("resolveAll with a source resolves only that source and returns the count", () => {
    const { pending, resolved } = setup();
    pending.add(question("p1"), "pi");
    pending.add(question("e1"), "edge");
    pending.add(question("p2"), "pi");

    expect(pending.resolveAll("cancelled", "pi")).toBe(2);
    expect(resolved).toEqual([
      ["p1", "cancelled"],
      ["p2", "cancelled"],
    ]);
    expect(pending.list().map((q) => q.id)).toEqual(["e1"]);
  });

  it("resolveAll without a source resolves every question in order", () => {
    const { pending, resolved } = setup();
    pending.add(question("a"), "edge");
    pending.add(question("b"), "pi");

    expect(pending.resolveAll("timeout")).toBe(2);
    expect(resolved).toEqual([
      ["a", "timeout"],
      ["b", "timeout"],
    ]);
    expect(pending.size).toBe(0);
  });

  it("wasResolved is true after resolving and false for unknown ids", () => {
    const { pending } = setup();
    pending.add(question("a"), "pi");
    expect(pending.wasResolved("a")).toBe(false);

    pending.resolve("a", "answered");
    expect(pending.wasResolved("a")).toBe(true);
    expect(pending.wasResolved("unknown")).toBe(false);
  });

  it("discardAll drops everything without onResolved, cancels timers and keeps them resolved", () => {
    const { pending, resolved } = setup();
    pending.add(question("a", { timeoutMs: 1000 }), "pi");
    pending.add(question("b"), "edge");

    pending.discardAll();

    expect(resolved).toEqual([]);
    expect(pending.list()).toEqual([]);
    expect(pending.size).toBe(0);
    expect(pending.wasResolved("a")).toBe(true);
    expect(pending.wasResolved("b")).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(resolved).toEqual([]);
  });
});
