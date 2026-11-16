import { describe, expect, it } from "vitest";
import {
  decodeQuestionTitle,
  encodeQuestionTitle,
  NETWORK_ANSWER_OPTIONS,
  QUESTION_KINDS,
} from "../src/index.js";

describe("encodeQuestionTitle", () => {
  it("prefixes the title with cna:<kind>:", () => {
    expect(encodeQuestionTitle("confirm", "Push?")).toBe("cna:confirm:Push?");
  });
});

describe("decodeQuestionTitle", () => {
  it.each(QUESTION_KINDS)("round trips the kind %s", (kind) => {
    const encoded = encodeQuestionTitle(kind, "Some title");
    expect(decodeQuestionTitle(encoded)).toEqual({ kind, title: "Some title" });
  });

  it("treats a title without prefix as ask_user", () => {
    expect(decodeQuestionTitle("Plain title")).toEqual({ kind: "ask_user", title: "Plain title" });
  });

  it("keeps the raw title when the kind is unknown", () => {
    expect(decodeQuestionTitle("cna:foo:bar")).toEqual({
      kind: "ask_user",
      title: "cna:foo:bar",
    });
  });

  it("keeps the raw title when there is no second colon", () => {
    expect(decodeQuestionTitle("cna:confirm")).toEqual({
      kind: "ask_user",
      title: "cna:confirm",
    });
  });

  it("keeps colons of the title after the prefix", () => {
    expect(decodeQuestionTitle("cna:plan:a:b")).toEqual({ kind: "plan", title: "a:b" });
  });

  it("decodes an empty title", () => {
    expect(decodeQuestionTitle("cna:network:")).toEqual({ kind: "network", title: "" });
  });
});

describe("NETWORK_ANSWER_OPTIONS", () => {
  it("lists the answer options of network questions", () => {
    expect(NETWORK_ANSWER_OPTIONS).toEqual(["allow_once", "allow_always", "deny"]);
  });
});
