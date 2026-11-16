import { parseTodoDetails } from "@cna/shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import todoExtension from "../src/todo.js";

interface ToolResult {
  content: { type: string; text: string }[];
  details: unknown;
}

interface CapturedTool {
  name: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<ToolResult>;
}

function setup() {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool: vi.fn((definition: unknown) => {
      tool = definition as CapturedTool;
    }),
  };
  todoExtension(pi as unknown as ExtensionAPI);
  const run = (params: Record<string, unknown>) => {
    if (tool === undefined) throw new Error("todo was not registered");
    return tool.execute("call-1", params, undefined, undefined, undefined);
  };
  return {
    pi,
    run,
    get tool() {
      return tool;
    },
  };
}

describe("todo registration", () => {
  it("registers exactly one tool named todo", () => {
    const { pi, tool } = setup();
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(tool?.name).toBe("todo");
  });

  it("names todo in every prompt guideline", () => {
    const { tool } = setup();
    const guidelines = tool?.promptGuidelines ?? [];
    expect(guidelines.length).toBeGreaterThan(0);
    for (const guideline of guidelines) {
      expect(guideline).toContain("todo");
    }
  });

  it("declares the status as a plain string enum without anyOf", () => {
    const { tool } = setup();
    const schema = JSON.stringify(tool?.parameters);
    const parsed = JSON.parse(schema) as {
      properties: {
        todos: { items: { properties: { status: { type: string; enum: string[] } } } };
      };
    };
    const status = parsed.properties.todos.items.properties.status;
    expect(status.type).toBe("string");
    expect(status.enum).toEqual(["pending", "in_progress", "completed"]);
    expect(schema).not.toContain("anyOf");
  });
});

describe("todo execute", () => {
  it("returns the trimmed list with ids, marks and parseable details", async () => {
    const { run } = setup();

    const result = await run({
      todos: [
        { text: "  Read the code  ", status: "completed" },
        { text: "Write the tests", status: "in_progress" },
        { text: "Open the PR", status: "pending" },
      ],
    });

    const expected = [
      { id: 1, text: "Read the code", status: "completed" },
      { id: 2, text: "Write the tests", status: "in_progress" },
      { id: 3, text: "Open the PR", status: "pending" },
    ];
    expect(parseTodoDetails(result.details)).toEqual(expected);
    expect(result.details).toEqual({ todos: expected });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[x] 1. Read the code\n[>] 2. Write the tests\n[ ] 3. Open the PR",
      },
    ]);
  });

  it("clears the list when it is empty", async () => {
    const { run } = setup();

    const result = await run({ todos: [] });

    expect(result.content).toEqual([{ type: "text", text: "Task list cleared." }]);
    expect(result.details).toEqual({ todos: [] });
  });

  it("throws on a text that is empty or only spaces", async () => {
    const { run } = setup();

    await expect(run({ todos: [{ text: "", status: "pending" }] })).rejects.toThrow();
    await expect(run({ todos: [{ text: "   ", status: "pending" }] })).rejects.toThrow();
  });

  it("throws on a text longer than 500 characters and accepts 500", async () => {
    const { run } = setup();

    await expect(run({ todos: [{ text: "a".repeat(501), status: "pending" }] })).rejects.toThrow();
    const result = await run({ todos: [{ text: "a".repeat(500), status: "pending" }] });
    expect(parseTodoDetails(result.details)).toHaveLength(1);
  });

  it("throws on more than 50 items and accepts 50", async () => {
    const { run } = setup();
    const item = (n: number) => ({ text: `task ${n}`, status: "pending" });

    await expect(
      run({ todos: Array.from({ length: 51 }, (_, i) => item(i + 1)) }),
    ).rejects.toThrow();
    const result = await run({ todos: Array.from({ length: 50 }, (_, i) => item(i + 1)) });
    expect(parseTodoDetails(result.details)).toHaveLength(50);
  });

  it("throws when two items are in_progress", async () => {
    const { run } = setup();

    await expect(
      run({
        todos: [
          { text: "A", status: "in_progress" },
          { text: "B", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("throws on an unknown status", async () => {
    const { run } = setup();

    await expect(run({ todos: [{ text: "A", status: "done" }] })).rejects.toThrow();
  });
});
