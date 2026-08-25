import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Server modules import "server-only", whose default export throws by design so
 * that importing one from a client component is a build error.
 *
 * Next.js resolves it to a no-op on the server via the "react-server" export
 * condition. Setting that condition globally here also changes how CommonJS
 * packages resolve — `pg` in particular breaks — so alias just this one package
 * to the no-op the package itself ships.
 */
const serverOnlyStub = fileURLToPath(
  new URL("./node_modules/server-only/empty.js", import.meta.url),
);

export default defineConfig({
  resolve: {
    // Resolves the "@/*" alias from tsconfig.json natively.
    tsconfigPaths: true,
    alias: { "server-only": serverOnlyStub },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Playwright specs live in e2e/ and are run by `npm run test:e2e`.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
