#!/usr/bin/env node
import { randomBytes, scrypt } from "node:crypto";
import { createInterface } from "node:readline/promises";

/**
 * Produces the value for ADMIN_PASSWORD_HASH (#17).
 *
 *     node scripts/admin-password.mjs
 *
 * Reads the password from a prompt rather than from an argument, because an
 * argument goes into shell history and into the process list, where anyone on
 * the machine can read it. It is never written to a file — the output is the
 * hash, and the hash is what belongs in the environment.
 *
 * Kept as its own script, deliberately duplicating the parameters in
 * src/lib/admin/password.ts, so that generating a hash does not require building
 * the app or having a database. The format is asserted by a test in that module.
 */

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

const derive = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N, r: R, p: P, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = await rl.question("Admin password: ");
rl.close();

if (password.length < 12) {
  console.error("\nThat is under 12 characters. Pick a longer one — this is the only gate.");
  process.exit(1);
}

const salt = randomBytes(16);
const key = await derive(password, salt);

console.error("\nPut this in ADMIN_PASSWORD_HASH. It is not a secret in the way the");
console.error("password is, but it is still worth keeping out of the repository.\n");
// `:` and base64url rather than the conventional `$`-separated form: this value
// goes in an environment file, and Next.js expands `$NAME` when it loads one.
console.log(["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join(":"));
