import { describe, expect, it } from "vitest";
import { parseCheckpointId, RestoreCheckpointRequestSchema } from "../src/index.js";

describe("parseCheckpointId", () => {
  it.each([
    ["0", 0],
    ["7", 7],
    ["123456789", 123456789],
  ])("parses %s as %d", (value, expected) => {
    expect(parseCheckpointId(value)).toBe(expected);
  });

  it.each(["", "-1", "01", "1.0", "1e3", " 1", "1234567890", "abc"])(
    "returns null for %j",
    (value) => {
      expect(parseCheckpointId(value)).toBeNull();
    },
  );
});

describe("RestoreCheckpointRequestSchema", () => {
  it("accepts an empty body (files only)", () => {
    expect(RestoreCheckpointRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts conversation: true", () => {
    expect(RestoreCheckpointRequestSchema.safeParse({ conversation: true }).success).toBe(true);
  });

  it("rejects a conversation that is not a boolean", () => {
    expect(RestoreCheckpointRequestSchema.safeParse({ conversation: "yes" }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(RestoreCheckpointRequestSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
