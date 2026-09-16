import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Operational scripts are not app code
    "scripts/**",
    // Generated artifacts: Docusaurus bundle + OpenNext/wrangler output
    "public/docs/**",
    ".open-next/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
