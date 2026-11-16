import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import askUser from "../src/ask-user.js";

interface ToolResult {
  content: { type: string; text: string }[];
  details: { question: string; answer: string };
}

interface CapturedTool {
  name: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<ToolResult>;
}

function setup(answers: { select?: string; input?: string; editor?: string } = {}) {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool: vi.fn((definition: unknown) => {
      tool = definition as CapturedTool;
    }),
  };
  askUser(pi as unknown as ExtensionAPI);
  const ui = {
    select: vi.fn().mockResolvedValue(answers.select),
    input: vi.fn().mockResolvedValue(answers.input),
    editor: vi.fn().mockResolvedValue(answers.editor),
    confirm: vi.fn(),
  };
  const ctx = { cwd: "/tmp/unused", ui };
  const run = (params: Record<string, unknown>) => {
    if (tool === undefined) throw new Error("ask_user was not registered");
    return tool.execute("call-1", params, undefined, undefined, ctx);
  };
  return {
    pi,
    ui,
    run,
    get tool() {
      return tool;
    },
  };
}

describe("ask_user registration", () => {
  it("registers the ask_user tool once", () => {
    const { pi, tool } = setup();
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(tool?.name).toBe("ask_user");
  });

  it("names ask_user in every prompt guideline", () => {
    const { tool } = setup();
    const guidelines = tool?.promptGuidelines ?? [];
    expect(guidelines.length).toBeGreaterThan(0);
    for (const guideline of guidelines) {
      expect(guideline).toContain("ask_user");
    }
  });
});

describe("ask_user execute", () => {
  it("offers the options with select and returns the chosen one", async () => {
    const { ui, run } = setup({ select: "B" });

    const result = await run({ question: "Which database?", options: ["A", "B"] });

    expect(ui.select).toHaveBeenCalledWith("cna:ask_user:Which database?", ["A", "B"]);
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.editor).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: "B" }]);
    expect(result.details).toEqual({ question: "Which database?", answer: "B" });
  });

  it("asks for a single-line input when there are no options", async () => {
    const { ui, run } = setup({ input: "hello" });

    const result = await run({ question: "Name?" });

    expect(ui.input).toHaveBeenCalledWith("cna:ask_user:Name?");
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.editor).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("asks with the multi-line editor when multiline is true", async () => {
    const { ui, run } = setup({ editor: "line 1\nline 2" });

    const result = await run({ question: "Describe the change", multiline: true });

    expect(ui.editor).toHaveBeenCalledWith("cna:ask_user:Describe the change");
    expect(ui.input).not.toHaveBeenCalled();
    expect(result.details.answer).toBe("line 1\nline 2");
  });

  it("prefers options over multiline", async () => {
    const { ui, run } = setup({ select: "A" });

    await run({ question: "Pick", options: ["A"], multiline: true });

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(ui.editor).not.toHaveBeenCalled();
  });

  it("uses the trimmed question in the title and in details", async () => {
    const { ui, run } = setup({ input: "ok" });

    const result = await run({ question: "  Continue?  " });

    expect(ui.input).toHaveBeenCalledWith("cna:ask_user:Continue?");
    expect(result.details.question).toBe("Continue?");
  });

  it("titles the dialog with the cna:ask_user: prefix", async () => {
    const { ui, run } = setup({ input: "x" });

    await run({ question: "Anything?" });

    const title = ui.input.mock.calls[0]?.[0];
    expect(typeof title).toBe("string");
    expect(String(title).startsWith("cna:ask_user:")).toBe(true);
  });

  it("throws when the user does not answer", async () => {
    const { run } = setup({});

    await expect(run({ question: "Are you there?" })).rejects.toThrow(
      "The user did not answer the question.",
    );
  });

  it("throws when the user cancels a select", async () => {
    const { run } = setup({ select: undefined });

    await expect(run({ question: "Pick", options: ["A", "B"] })).rejects.toThrow(
      "The user did not answer the question.",
    );
  });

  it("throws and asks nothing when the question is empty", async () => {
    const { ui, run } = setup({ input: "x" });

    await expect(run({ question: "   " })).rejects.toThrow("The question is empty.");
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("throws on duplicated options without opening a dialog", async () => {
    const { ui, run } = setup({ select: "A" });

    await expect(run({ question: "Pick", options: ["A", "A"] })).rejects.toThrow(
      "Options must be unique.",
    );
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("throws on empty option strings without opening a dialog", async () => {
    const { ui, run } = setup({ select: "A" });

    await expect(run({ question: "Pick", options: ["A", "  "] })).rejects.toThrow(
      "Options must be non-empty strings.",
    );
    expect(ui.select).not.toHaveBeenCalled();
  });
});
