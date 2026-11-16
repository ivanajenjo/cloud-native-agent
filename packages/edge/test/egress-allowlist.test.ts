import { describe, expect, it } from "vitest";
import {
  BASE_ALLOWLIST,
  formatAllowlistEntry,
  matchesAllowlist,
  parseAllowlistEntry,
} from "../src/egress/allowlist.js";

describe("parseAllowlistEntry", () => {
  it("lowercases the host and removes a trailing dot", () => {
    expect(parseAllowlistEntry("GitHub.com.")).toEqual({ host: "github.com", wildcard: false });
  });

  it("parses a wildcard with a port", () => {
    expect(parseAllowlistEntry("*.example.com:8443")).toEqual({
      host: "example.com",
      wildcard: true,
      port: 8443,
    });
  });

  it("parses an IPv4 literal with a port as a host, not a wildcard", () => {
    expect(parseAllowlistEntry("10.0.0.5:11434")).toEqual({
      host: "10.0.0.5",
      wildcard: false,
      port: 11434,
    });
  });

  it("round-trips the canonical format", () => {
    for (const text of ["github.com", "github.com:8080", "*.example.com", "*.example.com:443"]) {
      expect(formatAllowlistEntry(parseAllowlistEntry(text))).toBe(text);
    }
    expect(formatAllowlistEntry(parseAllowlistEntry("GitHub.com.:80"))).toBe("github.com:80");
  });

  it.each([
    "",
    "a b",
    "https://x.com",
    "x.com/path",
    "*",
    "*.com",
    "a.*.com",
    "x*.com",
    "x.com:0",
    "x.com:65536",
    "x.com:abc",
    "[::1]:80",
    "a..b",
  ])("rejects %j", (text) => {
    expect(() => parseAllowlistEntry(text)).toThrow(/invalid allowlist entry/);
  });

  it("includes the offending text in the error message", () => {
    expect(() => parseAllowlistEntry("https://x.com")).toThrow("https://x.com");
  });
});

describe("matchesAllowlist", () => {
  const entries = (...texts: string[]) => texts.map((text) => parseAllowlistEntry(text));

  it("matches an exact host on 443 and 80 by default, but not on 8443", () => {
    const list = entries("github.com");
    expect(matchesAllowlist(list, "github.com", 443)).toBe(true);
    expect(matchesAllowlist(list, "github.com", 80)).toBe(true);
    expect(matchesAllowlist(list, "github.com", 8443)).toBe(false);
  });

  it("matches only the explicit port when one is given", () => {
    const list = entries("github.com:8443");
    expect(matchesAllowlist(list, "github.com", 8443)).toBe(true);
    expect(matchesAllowlist(list, "github.com", 443)).toBe(false);
    expect(matchesAllowlist(list, "github.com", 80)).toBe(false);
  });

  it("matches wildcard subdomains at any depth but not the suffix itself", () => {
    const list = entries("*.example.com");
    expect(matchesAllowlist(list, "a.example.com", 443)).toBe(true);
    expect(matchesAllowlist(list, "a.b.example.com", 443)).toBe(true);
    expect(matchesAllowlist(list, "example.com", 443)).toBe(false);
    expect(matchesAllowlist(list, "badexample.com", 443)).toBe(false);
  });

  it("compares the queried host case-insensitively and ignores a trailing dot", () => {
    const list = entries("github.com", "*.example.com");
    expect(matchesAllowlist(list, "GitHub.COM.", 443)).toBe(true);
    expect(matchesAllowlist(list, "A.Example.Com.", 443)).toBe(true);
  });

  it("returns false for an empty list", () => {
    expect(matchesAllowlist([], "github.com", 443)).toBe(false);
  });
});

describe("BASE_ALLOWLIST", () => {
  it("parses every entry", () => {
    for (const text of BASE_ALLOWLIST) {
      expect(() => parseAllowlistEntry(text)).not.toThrow();
    }
  });

  it("allows github.com on 443", () => {
    const entries = BASE_ALLOWLIST.map((text) => parseAllowlistEntry(text));
    expect(matchesAllowlist(entries, "github.com", 443)).toBe(true);
  });
});
