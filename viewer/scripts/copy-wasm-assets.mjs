/**
 * Copies the WebAssembly binaries and DuckDB web workers that the
 * Perspective report needs at runtime from node_modules into public/,
 * where they are served as static assets.
 *
 * Run automatically by the predev/prebuild/prestart npm scripts.
 */

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const viewerDir = dirname(dirname(fileURLToPath(import.meta.url)));

const assets = [
  // Perspective engine + client wasm
  ["@perspective-dev/server/dist/wasm/perspective-server.wasm", "public/perspective/perspective-server.wasm"],
  ["@perspective-dev/viewer/dist/wasm/perspective-viewer.wasm", "public/perspective/perspective-viewer.wasm"],
  // The self-contained viewer module. It is served as a static asset and
  // imported at runtime (src/lib/energy/perspective.ts) instead of being
  // bundled: its init_client() imports the wasm glue from a runtime blob
  // URL, which bundlers cannot resolve.
  ["@perspective-dev/viewer/dist/esm/perspective-viewer.js", "public/perspective/perspective-viewer.js"],
  // DuckDB wasm bundles (eh = exception handling, mvp = fallback)
  ["@duckdb/duckdb-wasm/dist/duckdb-eh.wasm", "public/duckdb/duckdb-eh.wasm"],
  ["@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm", "public/duckdb/duckdb-mvp.wasm"],
  ["@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js", "public/duckdb/duckdb-browser-eh.worker.js"],
  ["@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js", "public/duckdb/duckdb-browser-mvp.worker.js"],
];

for (const [source, destination] of assets) {
  const from = join(viewerDir, "node_modules", source);
  const to = join(viewerDir, destination);
  if (!existsSync(from)) {
    console.error(`missing asset: ${source} — did npm install run?`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${source} -> ${destination}`);
}
