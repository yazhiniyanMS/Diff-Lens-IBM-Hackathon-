#!/usr/bin/env bash
# Initializes demo-repo/ as a local git repo (if not already) and provisions
# its dependencies, then sanity-checks its two demo branches.
set -euo pipefail

"$(dirname "$0")/init-demo-repo.sh"

cd "$(dirname "$0")/../demo-repo"

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
