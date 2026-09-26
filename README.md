# DiffLens

**Review Pull Requests by Intent, Not Just by Lines Changed.**
Target workflow: Pull-request review and change-risk assessment
DiffLens is an intent-aware pull-request review and change-risk assessment
tool built for the IBM hackathon problem statement: traditional code review
is line-oriented, but a small diff can have a large behavioral blast radius
across a repository's tests, API contracts, schemas, documentation, and
consumers. DiffLens parses a diff deterministically, gathers real repository
context, hands that evidence to an AI reasoning layer, and produces a
structured **Intent-Aware Review Brief** plus a visual **Review Radar** —
not another stream of generic AI comments.

## The problem, concretely

A reviewer looks at a 2-file, 8-line diff and it looks fine. What they don't
see without deeper digging: a frontend page still reading the old field
name, a contract test that will now fail, and API docs that are now wrong.
DiffLens exists to surface exactly that gap — see [Demo scenario](#demo-scenario-small-diff-large-blast-radius) below.

## Architecture

Deterministic repository analysis is kept strictly separate from AI
reasoning: the pipeline hands the AI layer *facts*, and the AI layer
produces *interpretation* — never the other way around.

```
Git Repository
   -> Diff Parser                 (server/lib/git.js, diffParser.js)
   -> Changed Symbol Extraction   (server/lib/symbolExtractor.js)
   -> Repository Context Engine   (server/lib/contextEngine.js)
   -> Relationship / Impact Graph (server/lib/relationshipGraph.js)
   -> AI Intent & Impact Analysis (server/lib/aiProvider/*)
   -> Risk / Test / Contract /
      Documentation Analysis      (server/lib/riskModel.js, reviewBrief.js)
   -> Structured Review Brief     (server/lib/schemas.js — Zod-validated)
   -> Review Radar / UI           (public/*)
   -> Fix Mode (patch + verify)   (server/lib/patch/*, verify.js)
```

Every AI-produced claim is tagged **fact** (directly observed in the diff or
repo) or **inference** (AI reasoning), and inferences carry evidence
(file + line references) back to the deterministic layer. The AI is never
asked to guess repository structure that can be computed directly.

### Tech stack

Plain **HTML/CSS/JavaScript** on the frontend (`public/`) served by a small
**Node.js + Express** backend (`server/`) — no build step, no framework
lock-in, deliberately easy for judges to read end-to-end during a demo.
Sessions are stored as JSON files (`server/lib/store.js`) rather than a
database, since a single-file store is the right amount of infrastructure
for a hackathon MVP; the interface is shaped so SQLite/Postgres can replace
it later without touching callers.

### AI provider abstraction — the IBM/Bob integration point

`server/lib/aiProvider/` defines an `AIProvider` interface
(`analyzeChange`, `generatePatch`, `assessEquivalence`) with two
implementations:

- **`MockAnalysisProvider`** (default) — a deterministic, evidence-grounded
  heuristic engine. It never calls an external model; every finding it
  produces is derived directly from the structured evidence package (removed/
  added field names, touched routes/symbols, ranked repository context). This
  keeps the UI, pipeline, and tests runnable with zero credentials and zero
  API spend.
- **`BobProvider`** — an isolated adapter for an IBM/Bob-hosted model
  endpoint, configured entirely through environment variables
  (`AI_PROVIDER=bob`, `BOB_API_URL`, `BOB_API_KEY`, `BOB_MODEL`). It sends the
  same structured evidence package, explicitly instructs the model that
  repository content is untrusted data (not instructions), and validates the
  response against the same Zod schema the mock provider satisfies.

**This repository does not fabricate an IBM Bob integration.** No Bob
endpoint or credentials were available in this environment, so `BobProvider`
is a real, working adapter shape with no live endpoint wired up — swapping
in the actual hackathon-provided endpoint is a matter of setting the three
environment variables above. Nothing else in the app changes when you switch
providers.

### Review Radar

The Radar (`public/js/radar.js`) is not decorative — every node comes from
`relationshipGraph.js`, built from real context-engine matches and AI
findings. Changed files sit at the center; surrounding rings (APIs/consumers,
services, schemas, tests, docs, dependencies) hold related files, colored and
glyph-marked by status (changed / affected / potentially affected / needs
attention / verified — status is never color-only, per accessibility
guidance). Clicking a node opens the exact evidence — matched terms, line
numbers, and the finding(s) that reference it.

### Fix Mode

Findings marked `actionable` (missing tests, stale structured API docs) can
generate a patch via **Suggest Fix**. Patches are template-driven, deterministic
operations (`replace_all` / `insert_after_match`), never raw model-executed
commands. Before anything is written:

1. Every target path is resolved and confirmed to stay inside the repo root
   (no traversal).
2. Every target path is checked against a secret/credential path denylist
   (`.env`, `.git/`, `*.pem`, `*.key`, `id_rsa`, credentials, `.aws/`, etc.).
3. The file's current on-disk content hash is compared against the hash
   taken at analysis time — if the file changed since analysis, the patch is
   rejected as stale and re-analysis is required.

Only a **preview** is generated first; applying requires an explicit
approve click. After apply, **Run Verification**
(`server/lib/verify.js`) detects and runs the repository's own test/lint
scripts from `package.json` — DiffLens never invents a verification command.

Note: doc patches are only offered for structured docs under `docs/**`. Free-form
prose (e.g. `README.md`) is deliberately excluded from automated find/replace,
since a blind replace can silently mangle a sentence, not just a field name.

## Evidence trail

`docs/bob-code-review/` contains generated evidence artifacts from an actual
analysis run of the demo scenario (regenerate anytime via the **Write
Evidence Docs** button, or `server/lib/evidenceWriter.js`):

- `change-intent.md` — deterministic diff facts + AI-inferred functional intent
- `impact-analysis.md` — blast-radius summary, contract changes, untouched files
- `review-questions.md` — concrete reviewer questions derived from evidence
- `missing-tests.md` — specific missing test cases with rationale and suggested assertions
- `session-summary.md` — the full analysis flow, request to result

Every section is generated from a real session object, not fabricated, and
each section is labeled deterministic fact vs. AI inference.

## Demo scenario: small diff, large blast radius

`demo-repo/` is a small full-stack orders app (Express backend, a frontend
consumer, contract tests, API docs) with two branches:

- `main` — the baseline. All 3 tests pass.
- `feature/simplify-order-response` — a 2-file, 8-line PR that renames the
  `/api/orders/:id` response field `customerName` → `name`. It looks
  reasonable in isolation.

Left untouched by that PR:

- `frontend/src/OrderCard.js` still reads `order.customerName` (now `undefined`)
- `tests/orders.contract.test.js` still asserts `customerName` — **it fails** (verify with `cd demo-repo && npm test` on each branch)
- `docs/api/orders.md` still documents `customerName` as the field name

### Demo flow

1. Click **Choose Repository Folder** and select `demo-repo/` (or **Upload
   .zip** with a zip of it — either way its `.git` history comes along, so
   DiffLens can diff it). Compare `main` → `feature/simplify-order-response`.
2. Inspect the raw diff — it's tiny, and looks fine.
3. Click **Analyze with DiffLens**. Watch the intent get inferred.
4. The Review Radar populates around the 2 changed files: the frontend
   consumer and contract test light up red ("needs attention"), docs light
   up amber.
5. Click the red `OrderCard.js` node — see the exact evidence (matched line,
   term, relationship) that flagged it.
6. Open **Testing Gaps** — a concrete missing/failing contract test, not
   "add more tests."
7. Open **Documentation Gaps** — click **Suggest Fix** on `docs/api/orders.md`,
   review the patch diff, approve, apply, and (optionally) run verification.
8. Open **Reviewer Questions** — concrete, evidence-backed questions to
   resolve before merge.
9. Triage findings (Accept/Dismiss/Needs Review), then **Generate Reviewer
   Summary** for a paste-ready summary of only the accepted findings.

## Setup

```bash
npm install
npm run setup:demo   # optional: re-provisions demo-repo/node_modules if needed
npm start             # DiffLens on http://localhost:5175
```

Then open the app and load a repository one of three ways:

- **Choose Repository Folder** — picks a local folder via the browser's
  native directory picker and uploads it (Chromium-based browsers include
  hidden files/folders in that selection, so `.git` comes along).
- **Upload .zip** — upload a zip of the repository (`.git` included).
- **Advanced: use a path already on this server** — for running DiffLens
  and the repo on the same machine, e.g. local development
  (`./demo-repo` works out of the box).

Either way, once loaded, choose `main` → `feature/simplify-order-response`
and analyze. Uploaded repos are extracted into `.difflens/uploads/` on the
server (per-file upload cap: 150MB, to bound memory use during extraction).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `mock` | `mock` (default, no credentials needed) or `bob` |
| `BOB_API_URL` | — | Required when `AI_PROVIDER=bob` |
| `BOB_API_KEY` | — | Bearer token for the Bob endpoint, if required |
| `BOB_MODEL` | `bob-default` | Model identifier passed to the Bob endpoint |
| `DIFFLENS_PORT` | `5175` | HTTP port for the DiffLens server |
| `DIFFLENS_DATA_DIR` | `./.difflens/sessions` | Where analysis sessions are persisted |

### Tests

```bash
npm test                 # DiffLens's own unit + e2e tests (39 assertions)
cd demo-repo && npm test # the demo app's own tests — fails on the feature
                          # branch by design (that's the point of the demo)
```

The DiffLens test suite (`tests/`) covers diff parsing, symbol extraction,
context/relationship logic, risk classification, Zod schema validation
(including AI response parsing and rejection of malformed responses), patch
path-traversal/secret-file/staleness safety, patch application, and a full
end-to-end run of the pipeline against the demo repo's incomplete PR —
asserting the exact blast-radius findings (untouched consumer, missing test,
stale docs, high-risk classification) are produced.

## What's MVP vs. roadmap

Built for this hackathon: local git repos (working tree, staged, or any
commit/branch comparison), the full deterministic pipeline, the mock AI
provider, the Bob adapter shape, the Review Radar, Fix Mode with safety
checks, verification, and the evidence trail.

Deliberately out of scope for the MVP (see task description rationale):
GitHub OAuth / hosted PR ingestion (the git abstraction in `server/lib/git.js`
is structured so this can be added without touching the rest of the
pipeline), authentication/teams/billing, a real database (Postgres can
replace the file-backed `SessionStore` without changing its call sites), and
a compiler-accurate cross-language dependency graph (the context engine is a
practical ranked-relevance retriever, not a type-checker).
