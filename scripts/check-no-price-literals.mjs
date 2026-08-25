#!/usr/bin/env node
/**
 * Fails if a price is written down anywhere but the pricing engine (#2).
 *
 * "Every displayed figure must derive from one calculation. No hardcoded totals
 * anywhere." A literal price in a component is how a receipt ends up disagreeing
 * with its own total, and it is invisible in review once the string looks
 * plausible.
 *
 * Run in CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = "src";

/** The engine owns prices. Its tests necessarily assert on them. */
const EXEMPT = [/^src[/\\]lib[/\\]pricing[/\\]/, /\.test\.tsx?$/];

const PATTERNS = [
  {
    name: "a literal money amount",
    // "$25.50", "$8.35/HR", "$5.00 BASE"
    pattern: /\$\d+(?:\.\d+)?/,
  },
  {
    name: "a literal hourly rate",
    // "8.35/hr", "5.00 per hour"
    pattern: /\d+\.\d{2}\s*(?:\/\s*hr\b|per hour\b)/i,
  },
  {
    name: "a literal multiplier",
    // "1.67x base", "1.7× base"
    pattern: /\d+\.\d+\s*[x×]\s*base/i,
  },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if ([".ts", ".tsx"].includes(extname(path))) yield path;
  }
}

const failures = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  if (EXEMPT.some((rule) => rule.test(file))) continue;
  scanned += 1;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    // A line that explains the rule is not a violation of it.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;

    for (const { name, pattern } of PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        failures.push(`${file}:${index + 1}  ${name}: ${match[0]}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error(`Prices written down outside the pricing engine (${scanned} files scanned):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nEvery displayed figure derives from one calculation. Import from");
  console.error("@/lib/pricing and format with @/lib/pricing/format instead.");
  process.exit(1);
}

console.log(`No price literals outside the pricing engine (${scanned} files scanned).`);
