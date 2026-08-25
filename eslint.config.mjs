import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

/**
 * Two project rules are defined here as disabled stubs. Each is turned on by the
 * issue that makes the codebase able to satisfy it — switching one on before then
 * would just fail CI on code that has not been written yet.
 *
 *   NO_RAW_HEX     -> enabled by #4  (design tokens and primitives)
 *   NO_BARE_ENV    -> enabled by #23 (environment config and secret handling)
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
      // Enabled by #4 and #23 respectively. See the note above.
      "no-restricted-syntax": ["off", NO_RAW_HEX, NO_BARE_ENV],
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
