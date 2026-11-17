import { describe, expect, it } from "vitest";
import { formatCost, formatDateTime, formatTokens } from "../src/views/usage-format.js";

describe("formatCost", () => {
  it("formats zero with two decimals", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("shows amounts below one cent as a bound", () => {
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.01)).toBe("$0.01");
  });

  it("uses two decimals and a dot", () => {
    expect(formatCost(0.45)).toBe("$0.45");
    expect(formatCost(12.3)).toBe("$12.30");
  });

  it("gives a dash for negative and NaN values", () => {
    expect(formatCost(-1)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("keeps counts below one thousand as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999)).toBe("999");
  });

  it("uses k with one decimal below 10 and none from 10 on", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1200)).toBe("1.2k");
    // 9.95 is stored just below 9.95, so toFixed(1) gives 9.9.
    expect(formatTokens(9950)).toBe("9.9k");
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(105000)).toBe("105k");
  });

  it("promotes to M instead of printing 1000k", () => {
    expect(formatTokens(999999)).toBe("1M");
    expect(formatTokens(999_999)).not.toContain("1000k");
  });

  it("uses M with the same rules", () => {
    expect(formatTokens(1000000)).toBe("1M");
    expect(formatTokens(1234567)).toBe("1.2M");
    expect(formatTokens(15000000)).toBe("15M");
  });

  it("gives a dash for negative and NaN values", () => {
    expect(formatTokens(-1)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("formats a valid ISO timestamp as local YYYY-MM-DD HH:MM", () => {
    const iso = new Date(2026, 10, 17, 9, 5, 7).toISOString();
    expect(formatDateTime(iso)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatDateTime(iso)).toBe("2026-11-17 09:05");
  });

  it("returns the input when it is not a valid date", () => {
    expect(formatDateTime("no es una fecha")).toBe("no es una fecha");
  });
});
