import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

/**
 * `promisify` cannot see the overload that takes cost parameters, so the wrapper
 * is written out. Async rather than `scryptSync` because scrypt is deliberately
 * slow: a synchronous one would block the event loop for every other request
 * while somebody signs in, which is a denial of service with a sign-in form
 * attached.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Admin password verification (#17).
 *
 * The issue rules out two specific things, and both are worth restating because
 * they are the shapes an admin gate usually takes when nobody is watching:
 *
 *   - **Not a shared secret in a URL.** A URL is written to proxy logs, browser
 *     history, `Referer` headers on every outbound link, and analytics. A secret
 *     in one is a secret in all of them.
 *   - **Not an env-var password compared without constant time.** `===` on a
 *     string returns as soon as two bytes differ, so the time it takes leaks how
 *     much of the guess was right — enough to recover a secret one byte at a
 *     time over a network.
 *
 * So the environment holds a **hash**, not a password. A leaked deployment
 * config is then a hash to attack offline rather than a working credential, and
 * scrypt's cost parameters are what make that attack expensive.
 *
 * `scrypt:N:r:p:salt:hash`, base64url. The parameters travel with the hash so
 * that raising them later does not invalidate every existing one.
 *
 * ## Why not the conventional `$`-separated form
 *
 * Because this value lives in an environment file, and Next.js expands `$NAME`
 * when it loads one. The usual `scrypt$16384$8$1$…` encoding comes out the other
 * side as `scrypt6384…` — every `$1`, `$8` and `$p` replaced by an empty
 * variable — and the only symptom is that the correct password stops working.
 * It failed exactly that way once here.
 *
 * `:` and base64url between them contain nothing a shell or a dotenv loader
 * treats as special, so the value that goes in is the value that comes out.
 */

const KEY_LENGTH = 32;

/**
 * Cost parameters. 16384 is scrypt's usual interactive setting: about 16MB of
 * memory and a few tens of milliseconds per attempt — unnoticeable on a sign-in
 * form, and the difference between a feasible and an infeasible offline attack.
 */
const DEFAULTS = { N: 16_384, r: 8, p: 1 } as const;

export class InvalidPasswordHashError extends Error {
  constructor(why: string) {
    super(`ADMIN_PASSWORD_HASH is not usable: ${why}`);
    this.name = "InvalidPasswordHashError";
  }
}

type Parsed = { N: number; r: number; p: number; salt: Buffer; hash: Buffer };

export function parsePasswordHash(encoded: string): Parsed {
  const parts = encoded.trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    throw new InvalidPasswordHashError("expected scrypt:N:r:p:salt:hash");
  }

  const [, rawN, rawR, rawP, salt, hash] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new InvalidPasswordHashError("cost parameters must be integers");
  }
  if (N < 1024) throw new InvalidPasswordHashError("N is too low to be worth having");

  const saltBytes = Buffer.from(salt!, "base64url");
  const hashBytes = Buffer.from(hash!, "base64url");
  if (saltBytes.length < 8) throw new InvalidPasswordHashError("salt is too short");
  if (hashBytes.length !== KEY_LENGTH) {
    throw new InvalidPasswordHashError(`hash must be ${KEY_LENGTH} bytes`);
  }

  return { N, r, p, salt: saltBytes, hash: hashBytes };
}

/** Produces the value that goes in `ADMIN_PASSWORD_HASH`. See scripts/admin-password.mjs. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...DEFAULTS,
    maxmem: 256 * 1024 * 1024,
  });

  return [
    "scrypt",
    DEFAULTS.N,
    DEFAULTS.r,
    DEFAULTS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join(":");
}

/**
 * Whether `password` is the one behind `encoded`.
 *
 * Constant-time in the comparison, and — because the derivation itself takes the
 * same time for every input — constant-time in the answer as well. The only
 * thing an attacker learns from how long this takes is that it ran.
 *
 * NFKC first, so a password typed with a composed accent verifies against one
 * stored with a decomposed one. Without it, the same keystrokes fail on a
 * different keyboard.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const { N, r, p, salt, hash } = parsePasswordHash(encoded);

  const derived = await scrypt(password.normalize("NFKC"), salt, hash.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });

  return derived.length === hash.length && timingSafeEqual(derived, hash);
}
