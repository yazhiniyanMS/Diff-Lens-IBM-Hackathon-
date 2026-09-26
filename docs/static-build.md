# The static build (`static/`)

`static/` is a second, complete implementation of DiffLens that runs **entirely
in the browser tab** — no Node process, no server, nothing to deploy or run.
Open `static/index.html` directly, or host the whole repo (or just the
`static/` folder) on GitHub Pages, and it works as-is.

This exists because a real Node backend (`server/` + `public/`) fundamentally
cannot be hosted on a static-only host like GitHub Pages — there is no
configuration that makes a static host run a process. If "zero server" is a
hard requirement, this is the actual answer, not a workaround.

## Why this is a different app, not a config flag

Making git operations, file uploads, and patch application work with no
server behind them means replacing every piece that used to talk to a real
`git` CLI and a real filesystem:

| Capability | Node build (`server/`) | Static build (`static/`) |
| --- | --- | --- |
| Git operations | real `git` CLI via `execFile` | [isomorphic-git](https://isomorphic-git.org/) + [LightningFS](https://github.com/isomorphic-git/lightning-fs) (an in-browser virtual filesystem), vendored into `static/vendor/git-bundle.js` |
| Unified diff text | `git diff`'s own output | [jsdiff](https://github.com/kpdecker/jsdiff) (`static/vendor/diff.js`) generates the hunks; a thin layer wraps them in synthetic `diff --git a/x b/x` headers so `server/lib/diffParser.js` parses them completely unchanged |
| Repo "upload" | multipart upload to Express, extracted to disk | the browser reads files directly into memory (folder picker / zip) or clones in-browser (GitHub URL) — never leaves the tab |
| Zip handling | `adm-zip` (Node) | [fflate](https://github.com/101arrowz/fflate) (`static/vendor/fflate.js`) |
| Schema validation | `zod` (npm) | the same `zod`, bundled to `static/vendor/zod.js` (see below) |
| Patch apply | write to the real filesystem | write to the in-browser virtual filesystem, **plus** the real disk when the repo was opened with `showDirectoryPicker()` (see "Writing back to disk") |
| Verification (test/lint) | runs the repo's own `npm test`/etc. | **not available** — a static page cannot execute an arbitrary repo's toolchain. This step is simply absent in the static build; re-run your test suite locally after applying a fix. |
| AI provider | any of mock/Ollama/Hugging Face/OpenRouter/Groq/Bob, server-side, keys from env vars | mock (default, offline) or a direct browser call to an OpenAI-chat-completions-compatible host, using a key you type into the page (kept in `localStorage`, sent only to that host) |
| Sessions | JSON files on disk | held in memory for the current tab only; nothing persists across a reload |

## What's reused unchanged

The deterministic core has no Node-specific dependencies once you take away
`node:fs`/`node:path`/the `git` CLI wrapper, so most of it is copied into
`static/js/lib/` byte-for-byte from `server/lib/`:

- `diffParser.js`, `symbolExtractor.js`, `riskModel.js`, `relationshipGraph.js`
- `aiProvider/AIProvider.js`, `aiProvider/prompt.js`, `aiProvider/mockProvider.js`
- `evidenceWriter.js` (as `lib/evidence.js` — same render functions, returning
  strings instead of calling `fs.writeFileSync`)

`contextEngine.js` and `reviewBrief.js` are ported (`browserContextEngine.js`,
`browserReviewBrief.js`) with the same logic, only changing the handful of
calls that used to go through `server/lib/git.js` to go through
`browserGit.js` instead. `public/js/radar.js` (the Review Radar renderer) is
copied verbatim — it only ever touched the DOM and an SVG.

## Vendoring, not a CDN

Browser-ready builds of isomorphic-git, LightningFS, jsdiff, fflate, and zod
are pre-built once (`tools/build-static-vendor/`, an authoring-only npm
project — not shipped, not run by end users) and checked into
`static/vendor/`. Two reasons, not one:

1. **No build step for anyone using this app.** Open `index.html` or push to
   Pages; nothing to `npm install` or compile.
2. isomorphic-git's package isn't browser-ready out of the box — its core
   uses the Node `Buffer`/`process` globals directly, and
   `@isomorphic-git/lightning-fs` ships as CommonJS. Both need a bundle step
   regardless of where the result ends up (a CDN wouldn't avoid this); doing
   it once at authoring time and committing the result is simpler and more
   robust than depending on a third-party CDN's uptime at every page load.

Regenerate after bumping a version in `tools/build-static-vendor/package.json`:

```bash
cd tools/build-static-vendor
npm install
node build.mjs
```

## Loading a repository

Three paths, all ending at the same place — a LightningFS instance
(`static/js/browserFs.js`) that isomorphic-git reads from:

- **Folder picker.** Chromium (`showDirectoryPicker()`) gives a real,
  writable `FileSystemDirectoryHandle` — DiffLens reads the whole tree
  (including `.git`) into the virtual filesystem, and keeps the handle so
  Fix Mode can write back to the real files later. Firefox/Safari fall back
  to the classic `<input webkitdirectory>` picker, which is read-only (no
  handle to write back through) — Fix Mode offers a download instead. Either
  way, the same `node_modules`/`dist`/`build`/etc. skip-list from the Node
  build's upload flow applies client-side, for the same reason: a real
  project's `node_modules` alone can be tens of thousands of files.
- **Zip upload.** Unzipped in-memory via fflate. Read-only, same as the
  webkitdirectory fallback.
- **GitHub URL.** Cloned directly from the browser via isomorphic-git's
  documented CORS-proxy pattern (GitHub's git-over-HTTP endpoints don't send
  CORS headers to anyone, static page or not — a proxy is the standard,
  necessary answer, not a workaround specific to this app). Uses the public
  proxy the isomorphic-git maintainers run for exactly this
  (`cors.isomorphic-git.org`); point `CORS_PROXY` in `browserGit.js` at a
  different one if you'd rather not depend on it. Shallow (last ~100 commits,
  all branches), same trade-off the Node build's own GitHub-clone endpoint
  makes.

## Writing back to disk

Fix Mode always updates the in-browser copy. When the repo was opened via
`showDirectoryPicker()`, it *also* writes the change back to the real file
through the same handle (`static/js/browserPatch.js`), so the fix actually
lands in your working copy — no download step needed. For zip/webkitdirectory/
GitHub-URL loads, there's no real handle to write through, so the app offers
the changed file as a direct download instead.

## AI providers in the browser

The mock provider (default) needs nothing and never makes a network call —
identical behavior to the Node build's default. For a real model, the
"AI Provider Settings" panel accepts a base URL, API key, and model for any
host that speaks the OpenAI chat-completions API *and* allows direct browser
(CORS) requests. Hugging Face's Inference Providers router is the one
preset built in because it's documented and commonly used for exactly this
client-side pattern; many other hosts (including OpenRouter and Groq, which
the Node build supports) don't reliably allow direct browser calls with a
key, which is why they're server-side-only options there. The key is stored
in this browser's `localStorage` and sent only to the host you configured —
never to any server of ours, because there isn't one.

## What was verified, and what wasn't

Everything below was exercised end-to-end in a real Chromium browser with
**no server running at all**, loading the demo repo's incomplete PR
(`demo-repo`, `main` → `feature/simplify-order-response`) and confirming it
produces the identical 10 findings / risk classifications / Review Radar
layout as the Node build on the same diff:

- Folder-picker load (webkitdirectory path) and zip load
- Diff computation via the tree-walk + jsdiff pipeline
- Full analysis pipeline (context engine, risk model, radar graph) with the
  mock provider
- Fix Mode: generate → validate → apply → stale-reapply correctly rejected
- Reviewer summary generation
- Evidence docs, zipped and downloaded
- Light/dark theme toggle

**Not verified in this environment**: cloning from a real GitHub URL. This
sandbox's network policy blocks the CORS proxy host outright (and CDN hosts
in general), so that specific path could not be exercised here, though it
follows isomorphic-git's own documented pattern rather than anything novel.
If it doesn't work for you, the folder/zip paths are unaffected and fully
verified.

## Known limitations (by design, not oversights)

- No verification step (can't run a repo's test/lint toolchain from a static
  page).
- No session persistence — refreshing the tab loses the current analysis.
- `STAGED` (index) comparisons are best-effort; `WORKING` (working tree) and
  branch-to-branch comparisons are the well-tested path.
- GitHub URL loading depends on a third-party CORS proxy being up.
