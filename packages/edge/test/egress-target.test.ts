import { describe, expect, it } from "vitest";
import { parseConnectAuthority, parseHttpProxyUrl } from "../src/egress/target.js";

describe("parseConnectAuthority", () => {
  it("parses host and port", () => {
    expect(parseConnectAuthority("github.com:443")).toEqual({ host: "github.com", port: 443 });
    expect(parseConnectAuthority("1.2.3.4:80")).toEqual({ host: "1.2.3.4", port: 80 });
  });

  it("lowercases the host and strips one trailing dot", () => {
    expect(parseConnectAuthority("GitHub.COM.:443")).toEqual({ host: "github.com", port: 443 });
  });

  it("strips brackets from IPv6 literals", () => {
    expect(parseConnectAuthority("[::1]:443")).toEqual({ host: "::1", port: 443 });
  });

  it.each([
    "github.com",
    "github.com:",
    "github.com:0",
    "github.com:65536",
    "github.com:44a",
    "user@github.com:443",
    "::1:443",
    ":443",
    "git hub.com:443",
    "a..b:443",
    "-x.com:443",
    `${"a".repeat(64)}.com:443`,
    "[fe80::1%eth0]:443",
    "[::1]443",
    "github.com:+443",
    "github.com:0443",
  ])("rejects %j", (authority) => {
    expect(parseConnectAuthority(authority)).toBeNull();
  });
});

describe("parseHttpProxyUrl", () => {
  it("accepts an absolute http URL with the default port and keeps the path and query", () => {
    expect(parseHttpProxyUrl("http://example.com/a?b=1")).toEqual({
      host: "example.com",
      port: 80,
      path: "/a?b=1",
    });
  });

  it("uses / as the path when there is none", () => {
    expect(parseHttpProxyUrl("http://example.com:8080")).toEqual({
      host: "example.com",
      port: 8080,
      path: "/",
    });
  });

  it("accepts IPv6 literals without brackets in the result", () => {
    expect(parseHttpProxyUrl("http://[::1]:8080/x")).toEqual({
      host: "::1",
      port: 8080,
      path: "/x",
    });
  });

  it.each([
    "https://example.com/",
    "ftp://x/",
    "http://u:p@example.com/",
    "http://@example.com/",
    "/relative",
    "not a url",
    "http://example.com:0/",
    "http://:80/",
  ])("rejects %j", (url) => {
    expect(parseHttpProxyUrl(url)).toBeNull();
  });
});
