# Reviewer Questions

Concrete questions a human reviewer should resolve before approving this PR,
derived from the repository evidence above (not generic AI review filler).

1. Is the rename from [customerName] to [name] intentional, and is it meant to ship in this PR or behind a compatibility shim?
2. frontend/src/OrderCard.js, frontend/src/api.js still reads the old field name — should this PR update them, or is a follow-up PR planned before merge?
3. Should tests/orders.contract.test.js, tests/order.model.test.js be updated in this PR so the contract test still enforces the response shape?
4. Should README.md, docs/api/orders.md be updated before merge so published API docs match the new response shape?
5. Is this a versioned/breaking API change? Should /, /:id bump a version or support both field names during a migration window?
