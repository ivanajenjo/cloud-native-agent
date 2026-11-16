import { describe, expect, it } from "vitest";
import { parseTodoDetails } from "../src/index.js";

describe("parseTodoDetails", () => {
  it("returns the list of a valid details object", () => {
    const todos = [
      { id: 1, text: "Read the plan", status: "completed" },
      { id: 2, text: "Write the tests", status: "in_progress" },
      { id: 3, text: "Open the PR", status: "pending" },
    ];
    expect(parseTodoDetails({ todos })).toEqual(todos);
  });

  it("drops extra fields of each item", () => {
    const result = parseTodoDetails({
      todos: [{ id: 1, text: "A", status: "pending", extra: true }],
    });
    expect(result).toEqual([{ id: 1, text: "A", status: "pending" }]);
  });

  it("accepts an empty list", () => {
    expect(parseTodoDetails({ todos: [] })).toEqual([]);
  });

  it.each([
    ["null", null],
    ["an empty array", []],
    ["a string", "x"],
    ["todos as a string", { todos: "x" }],
  ])("returns null for %s", (_name, details) => {
    expect(parseTodoDetails(details)).toBeNull();
  });

  it("returns null when an item is not an object", () => {
    expect(parseTodoDetails({ todos: ["x"] })).toBeNull();
  });

  it.each([
    ["id 0", { id: 0, text: "A", status: "pending" }],
    ["id 1.5", { id: 1.5, text: "A", status: "pending" }],
    ["id as a string", { id: "1", text: "A", status: "pending" }],
    ["text that is not a string", { id: 1, text: 42, status: "pending" }],
    ["status done", { id: 1, text: "A", status: "done" }],
    ["status missing", { id: 1, text: "A" }],
  ])("returns null for an item with %s", (_name, item) => {
    expect(parseTodoDetails({ todos: [item] })).toBeNull();
  });

  it("returns null when any item of the list is invalid", () => {
    expect(
      parseTodoDetails({
        todos: [
          { id: 1, text: "A", status: "pending" },
          { id: 2, text: "B", status: "unknown" },
        ],
      }),
    ).toBeNull();
  });
});
