// Authoring-time build: produces static/vendor/git-bundle.js so the static/
// app has zero build step for end users -- they just open index.html (or
// serve it from GitHub Pages). Re-run this after bumping a dependency
// version in package.json here.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "..", "static", "vendor");
fs.mkdirSync(OUT_DIR, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(__dirname, "entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: path.join(OUT_DIR, "git-bundle.js"),
});
console.log("Wrote static/vendor/git-bundle.js");

// diff (jsdiff) ships a ready UMD browser build; fflate ships a ready ESM
// browser build; zod is plain self-contained ESM with no bare-specifier
// imports anywhere in the package. None of these need bundling -- just
// copy them (and zod's whole package dir, since its internal imports are
// all relative) into static/vendor/ as-is.
const NODE_MODULES = path.join(__dirname, "node_modules");

fs.copyFileSync(path.join(NODE_MODULES, "diff", "dist", "diff.js"), path.join(OUT_DIR, "diff.js"));
console.log("Wrote static/vendor/diff.js");

fs.copyFileSync(path.join(NODE_MODULES, "fflate", "esm", "browser.js"), path.join(OUT_DIR, "fflate.js"));
console.log("Wrote static/vendor/fflate.js");

// zod itself has no bare-specifier imports, but copying the whole npm
// package (source, type declarations, multiple format variants) is ~5MB
// for a browser than needs one ~100KB runtime file -- bundle it down to
// just what's actually imported.
await esbuild.build({
  entryPoints: [path.join(__dirname, "zod-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: path.join(OUT_DIR, "zod.js"),
});
console.log("Wrote static/vendor/zod.js");
