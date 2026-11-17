import type { SessionStatus } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatTime, statusLabel } from "../src/views/format.js";

describe("statusLabel", () => {
  it("returns the Spanish label of every status", () => {
    const cases: Record<SessionStatus, string> = {
      idle: "inactiva",
      cloning: "clonando",
      running: "trabajando",
      waiting_input: "esperando respuesta",
      ready: "lista",
      closed: "cerrada",
      error: "error",
    };
    for (const [status, label] of Object.entries(cases)) {
      expect(statusLabel(status as SessionStatus)).toBe(label);
    }
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1048576, "1.0 MB"],
    [1048575, "1.0 MB"],
    [3 * 1024 ** 3, "3.0 GB"],
  ])("formats %d bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("returns a dash for negative or NaN values", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [999, "999 ms"],
    [1000, "1.0 s"],
    [1250, "1.2 s"],
    [125000, "2 min 5 s"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("formatTime", () => {
  it("formats a valid ISO date as local HH:MM:SS", () => {
    expect(formatTime("2026-11-17T10:20:30.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns invalid input as is", () => {
    expect(formatTime("not a date")).toBe("not a date");
  });
});
