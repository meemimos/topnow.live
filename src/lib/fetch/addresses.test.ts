import { describe, expect, it } from "vitest";

import { classifyAddress, classifyAddresses, parseIpv4, parseIpv6 } from "./addresses";

/**
 * The SSRF address gate (#19).
 *
 * Written as a table rather than as prose because that is what the acceptance
 * asks for: every range that must be refused, named, so a future edit that drops
 * one fails here rather than in production. The metadata endpoint
 * (169.254.169.254) is the single most important row in it.
 */

const BLOCKED = [
  ["0.0.0.0", "this-network"],
  ["10.0.0.1", "private"],
  ["10.255.255.254", "private"],
  ["100.64.0.1", "carrier-grade NAT"],
  ["127.0.0.1", "loopback"],
  ["127.1.2.3", "loopback"],
  ["169.254.169.254", "cloud metadata"],
  ["172.16.0.1", "private"],
  ["172.31.255.254", "private"],
  ["192.168.1.1", "private"],
  ["192.0.2.5", "documentation"],
  ["198.18.0.1", "benchmarking"],
  ["198.51.100.7", "documentation"],
  ["203.0.113.9", "documentation"],
  ["224.0.0.1", "multicast"],
  ["255.255.255.255", "broadcast"],
] as const;

const ALLOWED = [
  "1.1.1.1",
  "8.8.8.8",
  "140.82.121.4", // github.com
  "185.199.108.153",
  "172.15.255.255", // just below the private block
  "172.32.0.1", // just above it
  "100.63.255.255", // just below carrier-grade NAT
  "100.128.0.1", // just above it
  "2606:4700:4700::1111",
] as const;

describe("classifyAddress", () => {
  it.each(BLOCKED)("refuses %s (%s)", (address) => {
    expect(classifyAddress(address).ok).toBe(false);
  });

  it.each(ALLOWED)("allows %s", (address) => {
    expect(classifyAddress(address).ok).toBe(true);
  });

  it("names why it refused, so a log line is debuggable", () => {
    const verdict = classifyAddress("169.254.169.254");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("link-local");
  });
});

describe("IPv6", () => {
  it.each([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique local"],
    ["fd12:3456::1", "unique local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
  ])("refuses %s (%s)", (address) => {
    expect(classifyAddress(address).ok).toBe(false);
  });

  /**
   * The interesting case. `::ffff:127.0.0.1` is loopback wearing a v6 literal,
   * and a check that only compares v6 prefixes waves it straight through.
   */
  it.each(["::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::ffff:192.168.0.1"])(
    "refuses IPv4-mapped %s",
    (address) => {
      expect(classifyAddress(address).ok).toBe(false);
    },
  );

  it("classifies a NAT64-translated address by what it actually reaches", () => {
    expect(classifyAddress("64:ff9b::127.0.0.1").ok).toBe(false);
    expect(classifyAddress("64:ff9b::8.8.8.8").ok).toBe(true);
  });

  it("allows a mapped public address", () => {
    expect(classifyAddress("::ffff:8.8.8.8").ok).toBe(true);
  });

  it("treats a zone index as link-local regardless of the zone", () => {
    expect(classifyAddress("fe80::1%eth0").ok).toBe(false);
  });
});

describe("parsing", () => {
  it("rejects a leading-zero octet rather than guessing its base", () => {
    // "0177.0.0.1" is 127.0.0.1 to an octal-aware resolver. Two parsers that
    // disagree about a value is exactly the ambiguity an attacker wants.
    expect(parseIpv4("0177.0.0.1")).toBeNull();
    expect(parseIpv4("010.0.0.1")).toBeNull();
  });

  it.each(["1.2.3", "1.2.3.4.5", "1.2.3.256", "1.2.3.-1", "", "1.2.3.a"])(
    "rejects the malformed quad %s",
    (input) => {
      expect(parseIpv4(input)).toBeNull();
    },
  );

  it("expands :: to a full sixteen bytes", () => {
    expect(parseIpv6("::1")).toEqual([...new Array<number>(15).fill(0), 1]);
    expect(parseIpv6("2001:db8::1")?.length).toBe(16);
  });

  it.each(["1:::2", "12345::1", "gggg::1", ":::"])("rejects the malformed literal %s", (input) => {
    expect(parseIpv6(input)).toBeNull();
  });

  it("rejects a compression that stands for no zero groups", () => {
    // Eight groups either side of "::" is sixteen bytes already, so the "::"
    // expands to nothing — which is not a valid literal.
    expect(parseIpv6("1:2:3:4:5:6:7:8::")).toBeNull();
  });

  /** Anything unparseable is refused. A gate that opens on confusion is not a gate. */
  it.each(["localhost", "example.com", "not-an-address", ""])("refuses %s", (input) => {
    expect(classifyAddress(input).ok).toBe(false);
  });
});

describe("classifyAddresses", () => {
  it("refuses when any answer is unsafe, not only the first", () => {
    // A name answering with one public and one loopback address is a DNS
    // rebinding attempt. Accepting it because the first looked fine is the bug.
    expect(classifyAddresses(["8.8.8.8", "127.0.0.1"]).ok).toBe(false);
    expect(classifyAddresses(["127.0.0.1", "8.8.8.8"]).ok).toBe(false);
  });

  it("allows only when every answer is safe", () => {
    expect(classifyAddresses(["8.8.8.8", "1.1.1.1"]).ok).toBe(true);
  });

  it("refuses a name that resolved to nothing", () => {
    expect(classifyAddresses([]).ok).toBe(false);
  });
});
