# Change Intent

**Repository:** demo-repo
**Comparing:** `main` → `feature/simplify-order-response`
**Analysis provider:** mock-heuristic

## Deterministic facts (from the diff, not AI-derived)

- Files changed: 2
- Additions / deletions: +4 / -4
- Modified: backend/models/order.js, backend/routes/orders.js
- Added: none
- Deleted: none
- Removed field name(s) observed in the diff: customerName
- Added field name(s) observed in the diff: name

## AI-inferred functional intent

> Rename/restructure the response field(s) [customerName] to [name] on GET /, GET /:id, apparently to simplify the API's naming.

_Provenance: inference._

## Behavioral changes

- **[fact]** The response/data shape changed: field(s) [customerName] were removed and [name] were introduced in backend/models/order.js, backend/routes/orders.js.
- `backend/models/order.js` — field rename observed in diff
- `backend/routes/orders.js` — field rename observed in diff
