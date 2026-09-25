#!/usr/bin/env node
/**
 * A native-`solc` command line over solcjs, for machines that cannot download
 * the native compiler.
 *
 * forge normally fetches solc from binaries.soliditylang.org. Where that host is
 * blocked (some sandboxed and cloud environments), point forge here instead:
 *
 *   FOUNDRY_SOLC="$PWD/scripts/solcjs-shim.mjs" npm run contracts:test
 *
 * The path must be absolute: forge resolves it against the contracts root.
 *
 * solcjs is the same compiler built to WebAssembly and is pinned in
 * package.json to the version foundry.toml asks for, so the bytecode is the
 * same; it is only slower. CI does not use this: it runs the native compiler.
 *
 * forge only ever calls `solc --version` and `solc --standard-json` with the
 * input on stdin, so that is all this implements.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const solc = createRequire(import.meta.url)("solc");
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log(`solc, the solidity compiler commandline interface\nVersion: ${solc.version()}`);
  process.exit(0);
}

if (!args.includes("--standard-json")) {
  console.error(`solcjs-shim: only --version and --standard-json are supported, got: ${args}`);
  process.exit(1);
}

// forge inlines every source it resolved, so this is only a fallback for an
// import it did not. Search the roots forge passed, then the working directory.
const roots = [];
args.forEach((arg, i) => {
  if (arg === "--base-path" || arg === "--include-path") roots.push(args[i + 1]);
});
roots.push(process.cwd());

function findImports(path) {
  for (const root of roots) {
    const file = resolve(root, path);
    if (existsSync(file)) return { contents: readFileSync(file, "utf8") };
  }
  return { error: `File not found: ${path}` };
}

process.stdout.write(solc.compile(readFileSync(0, "utf8"), { import: findImports }));
