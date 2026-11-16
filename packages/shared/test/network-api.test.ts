import { describe, expect, it } from "vitest";
import { UpdateNetworkPolicyRequestSchema } from "../src/index.js";

describe("UpdateNetworkPolicyRequestSchema", () => {
  it.each([
    ["only mode", { mode: "ask" }],
    ["only an empty allow list", { allow: [] }],
    ["mode and allow", { mode: "audit", allow: ["*.example.com", "a.b:8443"] }],
  ])("accepts %s", (_name, body) => {
    expect(UpdateNetworkPolicyRequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects an empty body with the expected message", () => {
    const result = UpdateNetworkPolicyRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("expected mode or allow");
  });

  it("rejects an unknown mode", () => {
    expect(UpdateNetworkPolicyRequestSchema.safeParse({ mode: "deny" }).success).toBe(false);
  });

  it("rejects an empty string in allow", () => {
    expect(UpdateNetworkPolicyRequestSchema.safeParse({ allow: [""] }).success).toBe(false);
  });

  it("rejects more than 500 allow entries", () => {
    const allow = Array.from({ length: 501 }, (_, i) => `host${i}.example.com`);
    expect(UpdateNetworkPolicyRequestSchema.safeParse({ allow }).success).toBe(false);
  });

  it("accepts exactly 500 allow entries", () => {
    const allow = Array.from({ length: 500 }, (_, i) => `host${i}.example.com`);
    expect(UpdateNetworkPolicyRequestSchema.safeParse({ allow }).success).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(UpdateNetworkPolicyRequestSchema.safeParse({ mode: "ask", extra: 1 }).success).toBe(
      false,
    );
  });
});
