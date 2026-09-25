#!/usr/bin/env node
/**
 * Fails if a server-side secret reached the browser bundle.
 *
 * Next.js only inlines NEXT_PUBLIC_* variables, so a leak normally means someone
 * imported a server module from a client component, or hardcoded a value. This
 * checks the built output rather than trusting that convention held.
 *
 * Run after `next build`. Part of CI (#23).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIRS = [".next/static"];

// Variable names whose *values* must never appear in client output. Names are
// added here by the issue that introduces the variable.
const SERVER_ONLY_VARS = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CRON_SECRET",
  "ADMIN_PASSWORD_HASH",
  "ADMIN_SESSION_SECRET",
];

// Shapes that are secrets regardless of which variable carried them.
const SECRET_PATTERNS = [
  { name: "Stripe secret key", pattern: /\bsk_(test|live)_[A-Za-z0-9]{16,}/ },
  { name: "Stripe webhook secret", pattern: /\bwhsec_[A-Za-z0-9]{16,}/ },
  { name: "Postgres connection string", pattern: /\bpostgres(ql)?:\/\/[^\s"'`]+:[^\s"'`]+@/ },
  { name: "Private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(js|mjs|css|json|map)$/.test(path)) yield path;
  }
}

const failures = [];

// Values actually present in this environment, so a real leak is caught even
// when the value looks like nothing in particular.
const liveSecrets = SERVER_ONLY_VARS.map((name) => [name, process.env[name]]).filter(
  ([, value]) => typeof value === "string" && value.length >= 12,
);

let scanned = 0;
for (const dir of CLIENT_DIRS) {
  for (const file of walk(dir)) {
    scanned += 1;
    const contents = readFileSync(file, "utf8");

    for (const [name, value] of liveSecrets) {
      if (contents.includes(value)) {
        failures.push(`${file}: contains the value of ${name}`);
      }
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = contents.match(pattern);
      if (match) {
        failures.push(`${file}: looks like a ${name} (${match[0].slice(0, 12)}…)`);
      }
    }
  }
}

if (scanned === 0) {
  console.error("No client bundle found. Run `npm run build` first.");
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`Secrets found in the client bundle (${scanned} files scanned):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nA server value reached the browser. Check for a server module");
  console.error("imported from a client component, or a hardcoded value.");
  process.exit(1);
}

console.log(`No secrets in the client bundle (${scanned} files scanned).`);
