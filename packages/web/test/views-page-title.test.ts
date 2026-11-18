import { describe, expect, it } from "vitest";
import { pageTitle } from "../src/views/format.js";

describe("pageTitle", () => {
  it("is just the app name without replica or session", () => {
    expect(pageTitle(null, null)).toBe("cna");
  });

  it("adds the session status", () => {
    expect(pageTitle(null, "ready")).toBe("cna · lista");
  });

  it("adds the replica", () => {
    expect(pageTitle("agent-2", null)).toBe("cna · agent-2");
  });

  it("adds the replica and then the session status", () => {
    expect(pageTitle("agent-2", "running")).toBe("cna · agent-2 · trabajando");
  });
});
