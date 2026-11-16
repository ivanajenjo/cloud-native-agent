import { BlockList, isIP } from "node:net";

/** IPv4 ranges that must never be reached through the egress proxy. */
const INTERNAL_IPV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  INTERNAL_IPV4.addSubnet(address, prefix, "ipv4");
}

/** IPv6 ranges that must never be reached through the egress proxy. */
const INTERNAL_IPV6 = new BlockList();
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
] as const) {
  INTERNAL_IPV6.addSubnet(address, prefix, "ipv6");
}

/** IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`). */
const IPV4_MAPPED = new BlockList();
IPV4_MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/** IPv4-compatible IPv6 addresses (`::a.b.c.d`). */
const IPV4_COMPATIBLE = new BlockList();
IPV4_COMPATIBLE.addSubnet("::", 96, "ipv6");

/**
 * Extracts the embedded IPv4 address from the last 32 bits of an IPv6 literal.
 * Returns null if the literal cannot be parsed.
 */
function embeddedIpv4(ip: string): string | null {
  let text = ip;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const octets = text
      .slice(lastColon + 1)
      .split(".")
      .map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array<string>(zeros).fill("0"), ...tail].map((g) =>
    Number.parseInt(g, 16),
  );
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** True if `ip` (an IPv4 or IPv6 literal, IPv6 without brackets) must never be reached through the proxy. */
export function isInternalAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return INTERNAL_IPV4.check(ip, "ipv4");
  }
  if (family === 6) {
    if (INTERNAL_IPV6.check(ip, "ipv6")) return true;
    if (IPV4_MAPPED.check(ip, "ipv6") || IPV4_COMPATIBLE.check(ip, "ipv6")) {
      const v4 = embeddedIpv4(ip);
      // Fail closed if the embedded address cannot be read.
      return v4 === null ? true : INTERNAL_IPV4.check(v4, "ipv4");
    }
    return false;
  }
  // Not an IP literal (or scoped/invalid): fail closed.
  return true;
}
