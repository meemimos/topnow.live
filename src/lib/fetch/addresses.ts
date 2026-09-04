/**
 * Address classification for outbound fetches (#19).
 *
 * The avatar resolver fetches a URL that is partly derived from a handle a
 * stranger typed, so every fetch is a potential SSRF. The host allow-list in
 * `resolve.ts` is the first gate; this file is the second, and it is the one
 * that matters when DNS is the attack surface rather than the URL.
 *
 * The order that makes this work: resolve the hostname to addresses *first*,
 * check every address here, then connect to a checked address. Checking the
 * hostname alone is defeated by a name that resolves to 127.0.0.1, and checking
 * after connecting is checking after the request has already been made.
 *
 * Pure and total on purpose. Nothing in here does I/O, so the whole table of
 * dangerous ranges is testable directly instead of through a socket.
 */

export type AddressVerdict = { ok: true } | { ok: false; reason: string };

/** A dotted quad, strictly: four decimal octets, no leading zeros, no shorthand. */
export function parseIpv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    // Leading zeros are rejected rather than normalised: "0177.0.0.1" is octal
    // in some resolvers and decimal in others, and a value two parsers disagree
    // about is exactly the value an attacker wants.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * An IPv6 literal to sixteen bytes.
 *
 * Handles `::` compression and a trailing dotted quad (`::ffff:127.0.0.1`),
 * because the trailing-quad form is the usual way a loopback address is smuggled
 * past a check that only looks at IPv6 prefixes.
 */
export function parseIpv6(input: string): number[] | null {
  let text = input;

  // A zone index ("fe80::1%eth0") names an interface, which by definition means
  // link-local. Drop it here; the prefix check below refuses the address anyway.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  if (text.includes(":::")) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const expand = (half: string): number[] | null => {
    if (half === "") return [];
    const groups = half.split(":");
    const bytes: number[] = [];

    for (const [index, group] of groups.entries()) {
      const last = index === groups.length - 1;
      if (last && group.includes(".")) {
        const quad = parseIpv4(group);
        if (!quad) return null;
        bytes.push(...quad);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0] ?? "");
  if (!head) return null;

  if (halves.length === 1) return head.length === 16 ? head : null;

  const tail = expand(halves[1] ?? "");
  if (!tail) return null;

  const gap = 16 - head.length - tail.length;
  // "::" must stand for at least one zero group, so a full sixteen bytes either
  // side of it is not a valid compression.
  if (gap < 1) return null;

  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** Every IPv4 range that must never be the target of an outbound fetch. */
const BLOCKED_V4: ReadonlyArray<{ bytes: number[]; bits: number; reason: string }> = [
  { bytes: [0, 0, 0, 0], bits: 8, reason: "this-network" },
  { bytes: [10, 0, 0, 0], bits: 8, reason: "private" },
  // Carrier-grade NAT. Not routable on the public internet, and on a cloud host
  // it frequently addresses infrastructure.
  { bytes: [100, 64, 0, 0], bits: 10, reason: "carrier-grade NAT" },
  { bytes: [127, 0, 0, 0], bits: 8, reason: "loopback" },
  // The metadata endpoint on every major cloud lives at 169.254.169.254. This
  // single range is the reason SSRF is worth this much code.
  { bytes: [169, 254, 0, 0], bits: 16, reason: "link-local" },
  { bytes: [172, 16, 0, 0], bits: 12, reason: "private" },
  { bytes: [192, 0, 0, 0], bits: 24, reason: "IETF protocol assignments" },
  { bytes: [192, 0, 2, 0], bits: 24, reason: "documentation" },
  { bytes: [192, 88, 99, 0], bits: 24, reason: "6to4 relay anycast" },
  { bytes: [192, 168, 0, 0], bits: 16, reason: "private" },
  { bytes: [198, 18, 0, 0], bits: 15, reason: "benchmarking" },
  { bytes: [198, 51, 100, 0], bits: 24, reason: "documentation" },
  { bytes: [203, 0, 113, 0], bits: 24, reason: "documentation" },
  { bytes: [224, 0, 0, 0], bits: 4, reason: "multicast" },
  { bytes: [240, 0, 0, 0], bits: 4, reason: "reserved" },
];

function withinPrefix(address: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < prefix.length && remaining > 0; index += 1) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((address[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function classifyIpv4(bytes: number[]): AddressVerdict {
  for (const range of BLOCKED_V4) {
    if (withinPrefix(bytes, range.bytes, range.bits)) {
      return { ok: false, reason: `${bytes.join(".")} is ${range.reason}` };
    }
  }
  return { ok: true };
}

/** IPv6 prefixes that are never a legitimate avatar host. */
const BLOCKED_V6: ReadonlyArray<{ bytes: number[]; bits: number; reason: string }> = [
  { bytes: [0xfc, 0x00], bits: 7, reason: "unique local" },
  { bytes: [0xfe, 0x80], bits: 10, reason: "link-local" },
  { bytes: [0xff], bits: 8, reason: "multicast" },
  { bytes: [0x20, 0x01, 0x0d, 0xb8], bits: 32, reason: "documentation" },
];

function classifyIpv6(bytes: number[]): AddressVerdict {
  const unspecified = bytes.every((byte) => byte === 0);
  if (unspecified) return { ok: false, reason: ":: is unspecified" };

  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (loopback) return { ok: false, reason: "::1 is loopback" };

  // An IPv4-mapped or NAT64-translated address is an IPv4 destination wearing a
  // v6 literal. Classify what it actually reaches, not how it is spelled.
  const mappedV4 =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);

  if (mappedV4 || nat64) return classifyIpv4(bytes.slice(12));

  for (const range of BLOCKED_V6) {
    if (withinPrefix(bytes, range.bytes, range.bits)) {
      return { ok: false, reason: `address is ${range.reason}` };
    }
  }
  return { ok: true };
}

/**
 * Whether a single resolved address may be connected to.
 *
 * An address that cannot be parsed is refused rather than allowed: this is a
 * gate, and a gate that opens on input it does not understand is not a gate.
 */
export function classifyAddress(address: string): AddressVerdict {
  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);

  const v6 = parseIpv6(address);
  if (v6) return classifyIpv6(v6);

  return { ok: false, reason: `${address} is not an IP address` };
}

/**
 * Every address a hostname resolved to must be safe, not merely one of them.
 *
 * A name that returns both a public address and 127.0.0.1 is a DNS rebinding
 * attempt; accepting it because the first answer looked fine is the bug this
 * function exists to not have.
 */
export function classifyAddresses(addresses: readonly string[]): AddressVerdict {
  if (addresses.length === 0) return { ok: false, reason: "host resolved to no addresses" };

  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
