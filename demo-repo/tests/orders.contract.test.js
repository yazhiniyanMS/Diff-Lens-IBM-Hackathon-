import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../backend/server.js";

// Contract test guarding the /api/orders/:id response shape documented in
// docs/api/orders.md. This is the test the PR should update but doesn't.
test("GET /api/orders/:id returns the documented contract fields", async () => {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/orders/ORD-1001`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(typeof body.customerName, "string", "expected customerName field per API contract");
    assert.ok(Array.isArray(body.items));
    assert.equal(typeof body.total, "number");
  } finally {
    server.close();
  }
});
