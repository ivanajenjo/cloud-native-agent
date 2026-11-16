import { DEFAULT_PORTS } from "@cna/shared";
import { describe, expect, it } from "vitest";

describe("DEFAULT_PORTS", () => {
  it("matches the ports documented in docs/PLAN.md", () => {
    expect(DEFAULT_PORTS).toEqual({ edgeApi: 8080, edgeProxy: 3128, gateway: 8090 });
  });
});
