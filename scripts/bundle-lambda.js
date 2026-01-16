#!/usr/bin/env node

/**
 * Bundles the Lambda function using esbuild
 * Creates an optimized single-file bundle for deployment
 */

import { build } from "esbuild";
import { rmSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

async function bundleLambda() {
  const distDir = join(projectRoot, "dist");

  // Clean dist directory
  console.log("Cleaning dist directory...");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  // Bundle with esbuild
  console.log("Bundling Lambda function...");
  await build({
    entryPoints: [join(projectRoot, "src/handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: join(distDir, "handler.js"),
    sourcemap: false,
    minify: true,
    external: [
      // AWS SDK v3 is included in Lambda runtime
      "@aws-sdk/*",
    ],
    banner: {
      // Required for ESM compatibility in Node.js
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  });

  console.log("Lambda bundle created at dist/handler.js");
}

bundleLambda().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
