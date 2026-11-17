import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, ResumeSessionRequestSchema } from "../src/index.js";

describe("ResumeSessionRequestSchema", () => {
  it("accepts an empty body and a prompt", () => {
    expect(ResumeSessionRequestSchema.safeParse({}).success).toBe(true);
    expect(ResumeSessionRequestSchema.safeParse({ prompt: "sigue" }).success).toBe(true);
  });

  it.each([
    ["empty prompt", { prompt: "" }],
    ["unknown field", { prompt: "x", repo: "a/b" }],
  ])("rejects %s", (_name, body) => {
    expect(ResumeSessionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("keeps a bounded history", () => {
    expect(HISTORY_LIMIT).toBe(50);
  });
});
