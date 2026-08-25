import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

/**
 * Two project rules, both enabled.
 *
 *   NO_RAW_HEX   (#4)  components use design tokens, never a literal colour.
 *   NO_BARE_ENV  (#23) configuration comes from the validated config module,
 *                      so a missing variable fails at boot rather than at the
 *                      first request that happens to need it.
 */

// #4: no component may declare a raw hex colour. Tokens only.
const NO_RAW_HEX = {
  selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
  message: "Raw hex colour. Use a design token from the Tailwind theme instead (see #4).",
};

// #23: no bare process.env access outside the config module.
const NO_BARE_ENV = {
  selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
  message:
    "Read configuration from the validated config module, not process.env directly (see #23).",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,

  {
    rules: {
      "no-restricted-syntax": ["error", NO_BARE_ENV, NO_RAW_HEX],
    },
  },

  {
    // The config module is the one place that reads the environment, so it is
    // necessarily exempt. Everything else here runs outside the Next.js runtime
    // — tooling configs, standalone scripts, the Prisma seed — and so cannot
    // import the server-only config module at all.
    files: [
      "src/lib/config/**",
      "src/instrumentation.ts",
      "scripts/**",
      "prisma/**",
      "*.config.ts",
      "*.config.mts",
      "*.config.mjs",
      "*.setup.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },

  {
    // Not application components: build scripts, the Prisma seed and e2e specs
    // may name a colour when asserting on one.
    files: ["scripts/**", "prisma/**", "e2e/**"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Reference artefacts, not project source. Not ours to lint.
    "TopNow.html",
    "reference/**",
    "src/generated/**",
  ]),
]);

export default eslintConfig;
