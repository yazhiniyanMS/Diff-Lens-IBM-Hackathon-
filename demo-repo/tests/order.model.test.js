import { test } from "node:test";
import assert from "node:assert/strict";
import { getOrderById } from "../backend/models/order.js";

test("getOrderById returns a known order", () => {
  const order = getOrderById("ORD-1001");
  assert.ok(order);
  assert.equal(order.id, "ORD-1001");
});

test("getOrderById returns null for unknown id", () => {
  assert.equal(getOrderById("nope"), null);
});
