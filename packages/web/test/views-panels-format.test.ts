import { NETWORK_DECISION_REASONS } from "@cna/shared";
import { describe, expect, it } from "vitest";
import {
  checkpointReasonLabel,
  formatBytes,
  formatClock,
  reasonLabel,
  shortSha,
  statusLetter,
} from "../src/views/panels-format.js";

describe("reasonLabel", () => {
  it("gives a Spanish label to every decision reason", () => {
    for (const reason of NETWORK_DECISION_REASONS) {
      const label = reasonLabel(reason);
      if (reason === "allowlist") {
        expect(label).toBe("allowlist");
      } else {
        expect(label, reason).not.toBe(reason);
      }
      expect(label.length, reason).toBeGreaterThan(0);
    }
  });

  it("maps the reasons with their Spanish labels", () => {
    expect(reasonLabel("audit")).toBe("auditoría");
    expect(reasonLabel("provider")).toBe("proveedor");
    expect(reasonLabel("user_denied")).toBe("denegado por el usuario");
    expect(reasonLabel("ask_timeout")).toBe("sin respuesta");
    expect(reasonLabel("dns_error")).toBe("error de DNS");
  });
});

describe("statusLetter", () => {
  it("maps each diff status to its letter", () => {
    expect(statusLetter("added")).toBe("A");
    expect(statusLetter("modified")).toBe("M");
    expect(statusLetter("deleted")).toBe("D");
    expect(statusLetter("renamed")).toBe("R");
  });
});

describe("shortSha", () => {
  it("keeps the first 7 characters", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  });

  it("returns short inputs unchanged", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("checkpointReasonLabel", () => {
  it("labels start and run", () => {
    expect(checkpointReasonLabel("start")).toBe("inicio");
    expect(checkpointReasonLabel("run")).toBe("ejecución");
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB and MB with base 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2097152)).toBe("2.0 MB");
  });
});

describe("formatClock", () => {
  it("formats a valid ISO timestamp as local HH:MM:SS", () => {
    const iso = new Date(2026, 10, 17, 9, 5, 7).toISOString();
    expect(formatClock(iso)).toBe("09:05:07");
  });

  it("returns the input when it is not a valid date", () => {
    expect(formatClock("no es una fecha")).toBe("no es una fecha");
  });
});
