# Missing Tests

## Update contract test in tests/orders.contract.test.js for the new response shape

**Why:** tests/orders.contract.test.js asserts on field(s) [customerName] that no longer exist in the response. Left as-is this test will fail (best case) or needs a new assertion on [name] to keep the contract enforced (worst case: silently deleted coverage).
**Target file:** `tests/orders.contract.test.js`

Suggested assertions:
- `expect(response.body).to.have.property('name')`

Evidence:
- `tests/orders.contract.test.js` (lines 5, 6, 7, 11, 14) — references removed field(s): customerName

