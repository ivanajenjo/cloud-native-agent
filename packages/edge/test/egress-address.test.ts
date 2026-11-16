import { describe, expect, it } from "vitest";
import { isInternalAddress } from "../src/egress/address.js";

describe("isInternalAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.50",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
    "",
  ])("treats %j as internal", (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "treats %j as public",
    (ip) => {
      expect(isInternalAddress(ip)).toBe(false);
    },
  );
});
