# Orders Demo App

A deliberately small full-stack app used as the DiffLens hackathon demo
fixture. It has a backend API, a frontend consumer, contract tests, and API
docs — enough surface area to show a small diff with a large blast radius.

## Run it

```bash
cd demo-repo
npm install
npm start        # API on :4100
npm test         # contract + model tests
```

## The demo scenario

Branch `feature/simplify-order-response` contains a small, locally-reasonable
PR: it renames `customerName` to `name` in the `/api/orders/:id` response,
touching only `backend/routes/orders.js` and `backend/models/order.js`.

Left untouched, and therefore broken or stale:

- `frontend/src/OrderCard.js` — still reads `order.customerName` (now `undefined`)
- `tests/orders.contract.test.js` — still asserts `customerName`, will fail
- `docs/api/orders.md` — still documents `customerName` as the field name

This is the scenario DiffLens is built to catch: the changed lines look fine
in isolation, but the actual behavioral and contract impact is much larger
than the diff suggests.
