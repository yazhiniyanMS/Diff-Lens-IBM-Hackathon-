#!/usr/bin/env bash
# Initializes demo-repo/ and sample-app/ as local git repos (if not already),
# provisions demo-repo's dependencies, and sanity-checks all branches.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/init-demo-repo.sh"

cd "$SCRIPT_DIR/../demo-repo"

echo "Installing demo-repo dependencies..."
npm install --silent

echo
echo "Branches:"
git branch --list

echo
echo "main branch tests (should all pass):"
git checkout -q main
npm test || true

echo
echo "feature/simplify-order-response tests (contract test should FAIL by design):"
git checkout -q feature/simplify-order-response
npm test || true

echo
echo "Demo repo ready. Point DiffLens at this directory and compare main -> feature/simplify-order-response."

echo
"$SCRIPT_DIR/init-sample-app.sh"
cd "$SCRIPT_DIR/../sample-app"
echo
echo "sample-app tests (both branches should pass -- it's a well-formed PR, not a trap):"
npm test || true
echo
echo "sample-app ready. Compare main -> feature/add-power-function for a low-risk contrast to demo-repo."
