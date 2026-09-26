import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols, symbolsTouchedByHunks } from "../server/lib/symbolExtractor.js";

const SAMPLE_JS = `
import { getOrderById } from "../models/order.js";

export function listOrders(req, res) {
  return res.json({});
}

router.get("/:id", (req, res) => {
  res.json({ id: 1 });
});

export class OrderService {}

interface Foo {}
`;

test("extracts imports, functions, classes, and routes from JS", () => {
  const s = extractSymbols("routes/orders.js", SAMPLE_JS);
  assert.equal(s.lang, "js");
  assert.ok(s.imports.some((i) => i.source === "../models/order.js"));
  assert.ok(s.functions.some((f) => f.name === "listOrders"));
  assert.ok(s.classes.some((c) => c.name === "OrderService"));
  assert.ok(s.routes.some((r) => r.method === "GET" && r.path === "/:id"));
});

test("returns empty symbol set for unsupported languages or missing content", () => {
  const s = extractSymbols("README.md", null);
  assert.deepEqual(s.functions, []);
  assert.deepEqual(s.imports, []);
});

test("extractObjectFieldNames-derived fields include object keys and property accesses", () => {
  const s = extractSymbols("x.js", `const o = { customerName: "a" }; console.log(o.customerName);`);
  assert.ok(s.fields.includes("customerName"));
});

test("symbolsTouchedByHunks finds the function/route a hunk falls inside", () => {
  const content = `function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n`;
  const symbols = extractSymbols("x.js", content);
  const hunks = [
    {
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      lines: [{ type: "add", content: "  return 3;", newLineNo: 6, oldLineNo: null }],
    },
  ];
  const touched = symbolsTouchedByHunks(symbols, hunks);
  assert.ok(touched.some((t) => t.name === "b"));
});
