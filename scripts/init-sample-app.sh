#!/usr/bin/env bash
# sample-app/ ships as plain tracked files (its main-branch state). This
# script (re)creates it as its own independent local git repository with
# two branches: `main` and `feature/add-power-function` -- a well-tested,
# well-documented, low-risk change, deliberately the opposite of
# demo-repo's incomplete PR. Safe to re-run any time.
set -euo pipefail

cd "$(dirname "$0")/../sample-app"

if [ -d .git ]; then
  echo "sample-app is already a git repository (.git exists). Nothing to do."
  echo "Delete sample-app/.git first if you want to rebuild it from scratch."
  exit 0
fi

git init -q
git config user.email "demo@difflens.local"
git config user.name "DiffLens Demo"
git checkout -q -b main
git add -A
git commit -q -m "Initial calculator module: add, subtract, multiply, divide"

git checkout -q -b feature/add-power-function

cat >> src/calculator.js <<'EOF'

export function power(base, exponent) {
  return Math.pow(base, exponent);
}
EOF

cat >> tests/calculator.test.js <<'EOF'

test("power", () => {
  assert.equal(power(2, 10), 1024);
});
EOF
sed -i.bak 's/import { add, subtract, multiply, divide } from "..\/src\/calculator.js";/import { add, subtract, multiply, divide, power } from "..\/src\/calculator.js";/' tests/calculator.test.js
rm -f tests/calculator.test.js.bak

cat >> docs/api.md <<'EOF'
| `power` | `(base, exponent) => number` | |
EOF

git add -A
git commit -q -m "Add power(base, exponent), with test and docs in the same commit"

git checkout -q main
echo "sample-app initialized with branches: main, feature/add-power-function"
git branch --list
