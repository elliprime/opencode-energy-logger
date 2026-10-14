import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // the viewer is a standalone project nested inside the plugin
    // repository, which also has a lockfile; keep the workspace root
    // scoped to the viewer directory.
    root: path.dirname(fileURLToPath(import.meta.url)),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
