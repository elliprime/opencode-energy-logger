import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // override default ignores of eslint-config-next
  globalIgnores([
    // ignores of eslint-config-next ('.next' at any depth, in
    // case Turbopack ever writes to a nested root):
    "**/.next/**",
    "out/**",
    "build/**",
    // wasm/worker assets copied from node_modules by
    // scripts/copy-wasm-assets.mjs:
    "public/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
