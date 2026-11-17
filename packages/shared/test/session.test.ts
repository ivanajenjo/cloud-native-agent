import { describe, expect, it } from "vitest";
import {
  AnswerRequestSchema,
  CreateSessionRequestSchema,
  PostMessageRequestSchema,
  SetModelRequestSchema,
} from "../src/index.js";

describe("CreateSessionRequestSchema", () => {
  it("accepts the minimal body", () => {
    expect(
      CreateSessionRequestSchema.safeParse({ repo: "octo/hello-world", prompt: "hi" }).success,
    ).toBe(true);
  });

  it("accepts a full body", () => {
    const result = CreateSessionRequestSchema.safeParse({
      repo: "octo/hello-world",
      baseBranch: "main",
      prompt: "hi",
      model: "ollama/qwen3-coder:30b",
      thinking: "high",
      mode: "auto",
      autoPush: true,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["repo without owner", { repo: "hello", prompt: "hi" }],
    ["repo as full URL", { repo: "https://github.com/a/b", prompt: "hi" }],
    ["repo named ..", { repo: "a/..", prompt: "hi" }],
    ["repo named .", { repo: "a/.", prompt: "hi" }],
    ["owner starting with a dash", { repo: "-a/b", prompt: "hi" }],
    ["repo with three segments", { repo: "a/b/c", prompt: "hi" }],
    ["empty prompt", { repo: "a/b", prompt: "" }],
    ["unknown field", { repo: "a/b", prompt: "hi", extra: 1 }],
    ["model without provider", { repo: "a/b", prompt: "hi", model: "gpt" }],
    ["unknown thinking level", { repo: "a/b", prompt: "hi", thinking: "huge" }],
  ])("rejects %s", (_name, body) => {
    expect(CreateSessionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("PostMessageRequestSchema", () => {
  it("accepts a text without mode", () => {
    expect(PostMessageRequestSchema.safeParse({ text: "x" }).success).toBe(true);
  });

  it("accepts a text with mode steer", () => {
    expect(PostMessageRequestSchema.safeParse({ text: "x", mode: "steer" }).success).toBe(true);
  });

  it("rejects an empty text", () => {
    expect(PostMessageRequestSchema.safeParse({ text: "" }).success).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(PostMessageRequestSchema.safeParse({ text: "x", mode: "now" }).success).toBe(false);
  });
});

describe("AnswerRequestSchema", () => {
  it.each([
    ["value", { value: "a" }],
    ["confirmed false", { confirmed: false }],
    ["cancelled true", { cancelled: true }],
  ])("accepts %s", (_name, body) => {
    expect(AnswerRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ["cancelled false", { cancelled: false }],
    ["empty object", {}],
    ["value together with confirmed", { value: "a", confirmed: true }],
    ["non-string value", { value: 1 }],
  ])("rejects %s", (_name, body) => {
    expect(AnswerRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("SetModelRequestSchema", () => {
  it("accepts a model reference", () => {
    expect(SetModelRequestSchema.safeParse({ model: "anthropic/claude-x" }).success).toBe(true);
  });

  it("rejects a body without model", () => {
    expect(SetModelRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("CreateSessionRequestSchema with pr", () => {
  it("accepts a PR session without prompt", () => {
    expect(CreateSessionRequestSchema.safeParse({ repo: "a/b", pr: 12 }).success).toBe(true);
  });

  it("accepts a PR session with prompt", () => {
    expect(CreateSessionRequestSchema.safeParse({ repo: "a/b", pr: 12, prompt: "x" }).success).toBe(
      true,
    );
  });

  it.each([
    ["no prompt and no pr", { repo: "a/b" }],
    ["pr 0", { repo: "a/b", pr: 0 }],
    ["pr not an integer", { repo: "a/b", pr: 1.5 }],
    ["pr as a string", { repo: "a/b", pr: "12" }],
  ])("rejects %s", (_name, body) => {
    expect(CreateSessionRequestSchema.safeParse(body).success).toBe(false);
  });
});
