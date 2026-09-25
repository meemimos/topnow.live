import { describe, expect, it } from "vitest";

import {
  InvalidPasswordHashError,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from "./password";

/**
 * Admin password verification (#17).
 *
 * The issue names two anti-requirements — not a shared secret in a URL, and not
 * an env-var password compared without constant time — so these tests are as
 * much about what the environment holds as about whether the check works.
 */

// One derivation is ~40ms, and several tests do two.
const SLOW = 20_000;

describe("hashPassword", () => {
  it("produces a value that verifies", { timeout: SLOW }, async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
  });

  it("never stores the password", { timeout: SLOW }, async () => {
    const encoded = await hashPassword("hunter2-hunter2-hunter2");
    // The whole point: a leaked deployment config is a hash to attack offline,
    // not a working credential.
    expect(encoded).not.toContain("hunter2");
  });

  it(
    "salts, so two operators with one password do not share a hash",
    { timeout: SLOW },
    async () => {
      const a = await hashPassword("the same password");
      const b = await hashPassword("the same password");
      expect(a).not.toBe(b);
      expect(await verifyPassword("the same password", b)).toBe(true);
    },
  );

  it("carries its cost parameters, so they can be raised later", { timeout: SLOW }, async () => {
    const parsed = parsePasswordHash(await hashPassword("anything at all"));
    expect(parsed.N).toBeGreaterThanOrEqual(16_384);
    expect(parsed.hash).toHaveLength(32);
  });

  it("contains nothing a dotenv loader will rewrite", { timeout: SLOW }, async () => {
    const encoded = await hashPassword("a password with real characters");
    // Next.js expands `$NAME` in a .env file. The conventional `scrypt$N$r$p$…`
    // encoding comes back as `scrypt6384…`, and the only symptom is that the
    // right password stops working. This is the guard against re-introducing it.
    expect(encoded).not.toContain("$");
    expect(encoded).toMatch(/^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  });
});

describe("verifyPassword", () => {
  it("refuses the wrong password", { timeout: SLOW }, async () => {
    const encoded = await hashPassword("the right one");
    expect(await verifyPassword("the wrong one", encoded)).toBe(false);
  });

  it("refuses a password that only shares a prefix", { timeout: SLOW }, async () => {
    // The failure mode a non-constant-time compare has: a guess that shares more
    // of the prefix takes longer to reject, and the secret comes out a byte at a
    // time. Nothing here can observe that, but the case is worth pinning.
    const encoded = await hashPassword("supersecretpassword");
    expect(await verifyPassword("supersecretpasswore", encoded)).toBe(false);
    expect(await verifyPassword("supersecret", encoded)).toBe(false);
  });

  it(
    "normalises, so the same keystrokes verify from a different keyboard",
    { timeout: SLOW },
    async () => {
      // é as one code point and as e + combining accent.
      const encoded = await hashPassword("café-au-lait-please");
      expect(await verifyPassword("café-au-lait-please", encoded)).toBe(true);
    },
  );
});

describe("parsePasswordHash", () => {
  it.each([
    ["an empty value", ""],
    ["a bare password", "hunter2"],
    ["a different algorithm", "argon2:1:2:3:c2FsdA:aGFzaA"],
    ["missing fields", "scrypt:16384:8:c2FsdA"],
    ["a non-numeric cost", "scrypt:lots:8:1:c2FsdA:aGFzaA"],
    ["a cost nobody should accept", "scrypt:2:8:1:c2FsdA:aGFzaA"],
    ["a short salt", "scrypt:16384:8:1:YWI:aGFzaA"],
    [
      "the conventional $-separated form, which a dotenv loader mangles",
      "scrypt$16384$8$1$c2FsdA$aGFzaA",
    ],
  ])("refuses %s", (_label, encoded) => {
    // A malformed hash must be an error rather than something that quietly
    // verifies nothing — or, worse, verifies everything.
    expect(() => parsePasswordHash(encoded)).toThrow(InvalidPasswordHashError);
  });

  it("says which variable is wrong, because that is what is actionable", () => {
    expect(() => parsePasswordHash("nonsense")).toThrow(/ADMIN_PASSWORD_HASH/);
  });
});
