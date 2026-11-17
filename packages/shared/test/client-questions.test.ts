import { describe, expect, it } from "vitest";
import { optionLabel } from "../src/client/index.js";
import type { Question } from "../src/index.js";

function question(kind: Question["kind"], options: string[] = []): Question {
  return {
    id: "q1",
    kind,
    method: "select",
    title: "Título",
    options,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("optionLabel", () => {
  it.each([
    ["allow_once", "Permitir esta vez"],
    ["allow_always", "Permitir siempre"],
    ["deny", "Denegar"],
  ])("labels the network option %s", (option, label) => {
    expect(optionLabel(question("network"), option)).toBe(label);
  });

  it.each([
    ["approve", "Aprobar"],
    ["request_changes", "Pedir cambios"],
  ])("labels the plan option %s", (option, label) => {
    expect(optionLabel(question("plan"), option)).toBe(label);
  });

  it("returns the option as is for an unknown network option", () => {
    expect(optionLabel(question("network"), "maybe")).toBe("maybe");
  });

  it("returns the option as is for an unknown plan option", () => {
    expect(optionLabel(question("plan"), "later")).toBe("later");
  });

  it.each(["ask_user", "confirm"] as const)("returns the option as is for kind %s", (kind) => {
    expect(optionLabel(question(kind), "approve")).toBe("approve");
    expect(optionLabel(question(kind), "deny")).toBe("deny");
  });

  it("does not return inherited object properties", () => {
    expect(optionLabel(question("network"), "toString")).toBe("toString");
    expect(optionLabel(question("plan"), "constructor")).toBe("constructor");
  });
});
