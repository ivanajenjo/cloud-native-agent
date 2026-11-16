import { parsePort } from "@cna/shared";
import { describe, expect, it } from "vitest";

describe("parsePort", () => {
  it("returns the fallback when the value is undefined", () => {
    expect(parsePort(undefined, 8090)).toBe(8090);
  });

  it("parses valid decimal ports", () => {
    expect(parsePort("8090", 1)).toBe(8090);
    expect(parsePort("1", 8090)).toBe(1);
    expect(parsePort("65535", 8090)).toBe(65535);
  });

  it.each(["", "0", "65536", "80a", "8.5", " 80", "-1"])("rejects %j", (value) => {
    expect(() => parsePort(value, 8090)).toThrow();
  });
});
