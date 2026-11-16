import type { AnswerRequest, Question } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { answerToUiResponse, outcomeOfAnswer, QuestionRegistry } from "../src/session/questions.js";

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

describe("QuestionRegistry", () => {
  it("adds and lists questions in insertion order", () => {
    const registry = new QuestionRegistry();
    registry.add(question("a"), "pi");
    registry.add(question("b"), "edge");
    registry.add(question("c"), "pi");

    expect(registry.size).toBe(3);
    expect(registry.list().map((q) => q.id)).toEqual(["a", "b", "c"]);
    expect(registry.get("b")).toEqual({ question: question("b"), source: "edge" });
    expect(registry.get("zzz")).toBeUndefined();
  });

  it("throws when adding a pending id again", () => {
    const registry = new QuestionRegistry();
    registry.add(question("a"), "pi");
    expect(() => registry.add(question("a"), "pi")).toThrow();
    expect(registry.size).toBe(1);
  });

  it("resolve returns the question and removes it", () => {
    const registry = new QuestionRegistry();
    registry.add(question("a"), "pi");

    expect(registry.resolve("a")).toEqual(question("a"));
    expect(registry.get("a")).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("resolve of an unknown id returns undefined", () => {
    const registry = new QuestionRegistry();
    expect(registry.resolve("nope")).toBeUndefined();
    expect(registry.wasResolved("nope")).toBe(false);
  });

  it("wasResolved is true after resolve and false for unknown ids", () => {
    const registry = new QuestionRegistry();
    registry.add(question("a"), "pi");
    expect(registry.wasResolved("a")).toBe(false);

    registry.resolve("a");
    expect(registry.wasResolved("a")).toBe(true);
    expect(registry.wasResolved("b")).toBe(false);
  });

  it("clear(source) removes only that source and keeps the rest pending", () => {
    const registry = new QuestionRegistry();
    registry.add(question("p1"), "pi");
    registry.add(question("e1"), "edge");
    registry.add(question("p2"), "pi");

    const cleared = registry.clear("pi");

    expect(cleared.map((q) => q.id)).toEqual(["p1", "p2"]);
    expect(registry.list().map((q) => q.id)).toEqual(["e1"]);
    expect(registry.get("e1")?.source).toBe("edge");
    expect(registry.wasResolved("p1")).toBe(true);
    expect(registry.wasResolved("e1")).toBe(false);
  });

  it("clear() empties everything and marks every id as resolved", () => {
    const registry = new QuestionRegistry();
    registry.add(question("a"), "pi");
    registry.add(question("b"), "edge");

    const cleared = registry.clear();

    expect(cleared.map((q) => q.id)).toEqual(["a", "b"]);
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.wasResolved("a")).toBe(true);
    expect(registry.wasResolved("b")).toBe(true);
  });

  it("remembers at most the last 1000 resolved ids", () => {
    const registry = new QuestionRegistry();
    for (let i = 0; i < 1001; i++) {
      registry.add(question(`q${i}`), "pi");
      registry.resolve(`q${i}`);
    }

    expect(registry.wasResolved("q0")).toBe(false);
    expect(registry.wasResolved("q1")).toBe(true);
    expect(registry.wasResolved("q1000")).toBe(true);
  });
});

describe("answerToUiResponse", () => {
  it("builds a value response for select when the value is an option", () => {
    const q = question("s1", { method: "select", options: ["Allow", "Block"] });
    expect(answerToUiResponse(q, { value: "Allow" })).toEqual({
      ok: true,
      response: { type: "extension_ui_response", id: "s1", value: "Allow" },
    });
  });

  it("builds a confirmed response for confirm", () => {
    const q = question("c1", { method: "confirm", message: "Push?" });
    expect(answerToUiResponse(q, { confirmed: false })).toEqual({
      ok: true,
      response: { type: "extension_ui_response", id: "c1", confirmed: false },
    });
  });

  it("builds a value response for input", () => {
    const q = question("i1", { method: "input" });
    expect(answerToUiResponse(q, { value: "hello" })).toEqual({
      ok: true,
      response: { type: "extension_ui_response", id: "i1", value: "hello" },
    });
  });

  it("builds a value response for editor", () => {
    const q = question("e1", { method: "editor", prefill: "text" });
    expect(answerToUiResponse(q, { value: "edited" })).toEqual({
      ok: true,
      response: { type: "extension_ui_response", id: "e1", value: "edited" },
    });
  });

  it("accepts cancelled for any method", () => {
    const methods: Question[] = [
      question("a", { method: "select", options: ["x"] }),
      question("b", { method: "confirm" }),
      question("c", { method: "input" }),
      question("d", { method: "editor" }),
    ];
    for (const q of methods) {
      expect(answerToUiResponse(q, { cancelled: true })).toEqual({
        ok: true,
        response: { type: "extension_ui_response", id: q.id, cancelled: true },
      });
    }
  });

  it("rejects a select value that is not one of the options", () => {
    const q = question("s1", { method: "select", options: ["Allow", "Block"] });
    const result = answerToUiResponse(q, { value: "Maybe" });
    expect(result.ok).toBe(false);
  });

  it("rejects {value} for confirm", () => {
    const q = question("c1", { method: "confirm" });
    const result = answerToUiResponse(q, { value: "yes" });
    expect(result).toEqual({ ok: false, message: "confirm expects {confirmed}" });
  });

  it("rejects {confirmed} for input", () => {
    const q = question("i1", { method: "input" });
    const result = answerToUiResponse(q, { confirmed: true });
    expect(result.ok).toBe(false);
  });

  it("rejects {confirmed} for select", () => {
    const q = question("s1", { method: "select", options: ["Allow"] });
    expect(answerToUiResponse(q, { confirmed: true }).ok).toBe(false);
  });
});

describe("outcomeOfAnswer", () => {
  it("maps cancelled to cancelled and any value to answered", () => {
    const cases: [AnswerRequest, "answered" | "cancelled"][] = [
      [{ cancelled: true }, "cancelled"],
      [{ value: "x" }, "answered"],
      [{ confirmed: false }, "answered"],
    ];
    for (const [answer, outcome] of cases) {
      expect(outcomeOfAnswer(answer)).toBe(outcome);
    }
  });
});
