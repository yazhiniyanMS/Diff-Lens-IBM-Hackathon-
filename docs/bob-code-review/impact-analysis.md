# Impact Analysis

## Blast radius summary

Changed files: **2** — Related nodes discovered: **8**

- **docs** (2): README.md [potentially_affected], docs/api/orders.md [potentially_affected]
- **tests** (2): tests/orders.contract.test.js [risk], tests/order.model.test.js [affected]
- **apis** (2): frontend/src/OrderCard.js [risk], frontend/src/api.js [affected]
- **services** (1): backend/server.js [affected]
- **dependencies** (1): package.json [affected]

## API & contract changes

- **[fact]** Endpoint(s) GET /, GET /:id changed their response contract by replacing field(s) [customerName] with [name].
- `backend/models/order.js` — route + field change observed in diff
- `backend/routes/orders.js` — route + field change observed in diff

## Impacted modules

- `README.md` (documentation) — References a field name that this PR removed from the response.
- `docs/api/orders.md` (documentation) — References a field name that this PR removed from the response.
- `tests/orders.contract.test.js` (test) — References a field name that this PR removed from the response.
- `frontend/src/OrderCard.js` (api_consumer) — References a field name that this PR removed from the response.
- `tests/order.model.test.js` (test) — References a function/symbol touched by this PR.
- `backend/server.js` (reference) — References a function/symbol touched by this PR.
- `frontend/src/api.js` (api_consumer) — References a function/symbol touched by this PR.
- `package.json` (dependency) — References a function/symbol touched by this PR.

## Backward compatibility concerns

- **[inference]** Removing field(s) [customerName] without a transition period breaks any consumer (internal or external) still reading the old field name, with no deprecation window.
- `frontend/src/OrderCard.js` (lines 3, 4, 5, 7, 10, 12, 13)

## Suspiciously untouched files

- `frontend/src/OrderCard.js` — Not modified by this PR but references the removed field(s) [customerName]. References a field name that this PR removed from the response.
- `frontend/src/OrderCard.js` (lines 3, 4, 5, 7, 10, 12, 13)

- `tests/orders.contract.test.js` — Not modified by this PR but references the removed field(s) [customerName]. References a field name that this PR removed from the response.
- `tests/orders.contract.test.js` (lines 5, 6, 7, 11, 14)

- `README.md` — Not modified by this PR but references the removed field(s) [customerName]. References a field name that this PR removed from the response.
- `README.md` (lines 18, 19, 20, 24, 25, 26)

- `docs/api/orders.md` — Not modified by this PR but references the removed field(s) [customerName]. References a field name that this PR removed from the response.
- `docs/api/orders.md` (lines 3, 5, 13, 25, 32, 33, 35, 37)
