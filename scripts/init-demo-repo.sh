#!/usr/bin/env bash
# demo-repo/ ships as plain tracked files (its base/main state) inside this
# repository — it is NOT a git submodule. This script (re)creates it as its
# own independent local git repository with the two branches the demo
# needs: `main` (baseline, all tests pass) and
# `feature/simplify-order-response` (the deliberately incomplete PR used in
# the DiffLens demo). Safe to re-run any time.
set -euo pipefail

cd "$(dirname "$0")/../demo-repo"

if [ -d .git ]; then
  echo "demo-repo is already a git repository (.git exists). Nothing to do."
  echo "Delete demo-repo/.git first if you want to rebuild it from scratch."
  exit 0
fi

git init -q
git config user.email "demo@difflens.local"
git config user.name "DiffLens Demo"
git checkout -q -b main
git add -A
git commit -q -m "Initial orders demo app: backend, frontend consumer, contract tests, docs"

git checkout -q -b feature/simplify-order-response
sed -i.bak 's/customerName: "Priya Nair"/name: "Priya Nair"/; s/customerName: "Daniel Kim"/name: "Daniel Kim"/' backend/models/order.js
sed -i.bak 's/customerName: order.customerName/name: order.name/g' backend/routes/orders.js
rm -f backend/models/order.js.bak backend/routes/orders.js.bak
git add backend/models/order.js backend/routes/orders.js
git commit -q -m "Simplify order response field naming (customerName -> name)"

git checkout -q main
echo "demo-repo initialized with branches: main, feature/simplify-order-response"
git branch --list
