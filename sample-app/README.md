# sample-app

A tiny, generic codebase for trying out DiffLens's upload flow on
something other than the `demo-repo/` blast-radius scenario. It has no
hidden gotcha -- it's here to test folder/zip/GitHub-URL loading and to
show what DiffLens looks like on an ordinary, well-tested, low-risk change.

## Run it

```bash
cd sample-app
npm test
```

## Branches

- `main` — `add`, `subtract`, `multiply`, `divide`, each documented in
  `docs/api.md` and covered by a test in `tests/calculator.test.js`.
- `feature/add-power-function` — adds a `power(base, exponent)` function,
  **with** a matching test and a matching docs update in the same commit.

Compare `main` → `feature/add-power-function` in DiffLens: since the new
function is self-contained, tested, and documented in the same change,
expect mostly **informational/low** findings -- a useful contrast against
`demo-repo`'s deliberately incomplete, high-risk PR. It's evidence that
DiffLens's risk model reacts to what's actually missing, not just "AI
found a diff."
