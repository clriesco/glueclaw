// Build glueclaw to dist/ for openclaw plugin loading.
//
// openclaw 2026.5.6+ requires compiled JS at one of:
//   ./dist/index.{js,mjs,cjs}, ./index.{js,mjs,cjs}
// and rejects TypeScript source plugins. We emit non-bundled per-file output
// so each ./src/*.ts becomes ./dist/src/*.js, preserving the import graph
// (which already uses `.js` extensions on relative specifiers).

import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "dist");

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name === "__tests__") continue;
      yield* walk(full);
    } else if (
      entry.isFile() &&
      extname(entry.name) === ".ts" &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      yield full;
    }
  }
}

const entryPoints = [];
entryPoints.push(join(ROOT, "index.ts"));
for await (const file of walk(join(ROOT, "src"))) entryPoints.push(file);

console.log(`Building ${entryPoints.length} entry points → ${relative(ROOT, OUT)}/`);

await build({
  entryPoints,
  outdir: OUT,
  outbase: ROOT,
  format: "esm",
  platform: "node",
  target: "node22",
  bundle: false,
  sourcemap: false,
  logLevel: "warning",
});

console.log("Build OK.");
