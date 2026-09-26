import { test } from "node:test";
import assert from "node:assert/strict";
import { add, subtract, multiply, divide } from "../src/calculator.js";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract", () => {
  assert.equal(subtract(5, 2), 3);
});

test("multiply", () => {
  assert.equal(multiply(4, 3), 12);
});

test("divide", () => {
  assert.equal(divide(10, 2), 5);
});

test("divide by zero throws", () => {
  assert.throws(() => divide(1, 0), /Division by zero/);
});
