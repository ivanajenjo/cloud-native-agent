import { describe, expect, it } from "vitest";
import { MODE_ENTRY_TYPE, PLAN_ANSWER_OPTIONS, parseModeEntry } from "../src/index.js";

describe("parseModeEntry", () => {
  it("reads the plan mode of a cna.mode custom entry", () => {
    expect(parseModeEntry({ type: "custom", customType: "cna.mode", data: { mode: "plan" } })).toBe(
      "plan",
    );
  });

  it("reads the auto mode of a cna.mode custom entry", () => {
    expect(parseModeEntry({ type: "custom", customType: "cna.mode", data: { mode: "auto" } })).toBe(
      "auto",
    );
  });

  it("uses the cna.mode custom type", () => {
    expect(MODE_ENTRY_TYPE).toBe("cna.mode");
  });

  it("returns null for another customType", () => {
    expect(
      parseModeEntry({ type: "custom", customType: "other", data: { mode: "plan" } }),
    ).toBeNull();
  });

  it("returns null for a message entry", () => {
    expect(
      parseModeEntry({ type: "message", customType: "cna.mode", data: { mode: "plan" } }),
    ).toBeNull();
  });

  it("returns null when data is missing", () => {
    expect(parseModeEntry({ type: "custom", customType: "cna.mode" })).toBeNull();
  });

  it("returns null for an unknown mode", () => {
    expect(
      parseModeEntry({ type: "custom", customType: "cna.mode", data: { mode: "x" } }),
    ).toBeNull();
  });

  it("returns null for a null entry", () => {
    expect(parseModeEntry(null)).toBeNull();
  });
});

describe("PLAN_ANSWER_OPTIONS", () => {
  it("is exactly approve and request_changes", () => {
    expect([...PLAN_ANSWER_OPTIONS]).toEqual(["approve", "request_changes"]);
  });
});
