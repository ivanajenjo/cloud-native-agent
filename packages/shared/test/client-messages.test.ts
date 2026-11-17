import { describe, expect, it } from "vitest";
import {
  messageText,
  messageThinking,
  messageToolCalls,
  toolResultText,
} from "../src/client/index.js";
import type { PiMessage } from "../src/index.js";

describe("messageText", () => {
  it("returns string content as is", () => {
    expect(messageText({ role: "user", content: "hola" })).toBe("hola");
  });

  it("concatenates text blocks with empty separator", () => {
    const message: PiMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hola " },
        { type: "thinking", thinking: "pienso" },
        { type: "text", text: "mundo" },
      ],
    };
    expect(messageText(message)).toBe("Hola mundo");
  });

  it("returns empty string when there are no text blocks", () => {
    expect(messageText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }] })).toBe(
      "",
    );
  });

  it.each<[string, unknown, string]>([
    ["null content", { role: "user", content: null }, ""],
    ["number content", { role: "user", content: 42 }, ""],
    ["object content", { role: "user", content: { type: "text", text: "x" } }, ""],
    ["array content with null", { role: "user", content: [null, 1, "x"] }, ""],
    ["text block without string text", { role: "user", content: [{ type: "text", text: 1 }] }, ""],
    ["no content", { role: "user" }, ""],
  ])("does not throw with %s", (_name, message, expected) => {
    expect(messageText(message as PiMessage)).toBe(expected);
  });

  it("does not throw with a null message", () => {
    expect(messageText(null as unknown as PiMessage)).toBe("");
  });
});

describe("messageThinking", () => {
  it("concatenates thinking blocks", () => {
    const message: PiMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a" },
        { type: "text", text: "x" },
        { type: "thinking", thinking: "b" },
      ],
    };
    expect(messageThinking(message)).toBe("ab");
  });

  it("returns empty string for string content", () => {
    expect(messageThinking({ role: "user", content: "hola" })).toBe("");
  });

  it.each([
    ["null", null],
    ["number", 3],
    ["array", [1, 2]],
  ])("does not throw with content %s", (_name, content) => {
    expect(messageThinking({ role: "assistant", content } as PiMessage)).toBe("");
  });
});

describe("messageToolCalls", () => {
  it("returns toolCall blocks in order", () => {
    const message: PiMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
        { type: "text", text: "x" },
        { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
      ],
    };
    expect(messageToolCalls(message)).toEqual([
      { id: "t1", name: "read", arguments: { path: "a" } },
      { id: "t2", name: "bash", arguments: { command: "ls" } },
    ]);
  });

  it("skips blocks without string id or name", () => {
    const message: PiMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", arguments: {} },
        { type: "toolCall", id: 7, name: "read", arguments: {} },
        { type: "toolCall", id: "t3", arguments: {} },
        { type: "toolCall", id: "t4", name: "ok", arguments: {} },
      ],
    };
    expect(messageToolCalls(message)).toEqual([{ id: "t4", name: "ok", arguments: {} }]);
  });

  it.each([
    ["string content", "hola"],
    ["null content", null],
    ["number content", 1],
    ["null block", [null, 1]],
  ])("returns [] for %s", (_name, content) => {
    expect(messageToolCalls({ role: "assistant", content } as PiMessage)).toEqual([]);
  });
});

describe("toolResultText", () => {
  it("joins text blocks with newline", () => {
    expect(
      toolResultText({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  it("returns a string result as is", () => {
    expect(toolResultText("done")).toBe("done");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 5],
    ["array", [{ type: "text", text: "x" }]],
    ["object without content array", { content: "x" }],
    ["content with null blocks", { content: [null, { type: "text" }] }],
  ])("returns empty text for %s", (_name, result) => {
    expect(toolResultText(result)).toBe("");
  });
});
