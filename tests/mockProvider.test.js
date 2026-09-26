import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAnalysisProvider } from "../server/lib/aiProvider/mockProvider.js";
import { AnalysisResultSchema, PatchProposalSchema } from "../server/lib/schemas.js";

function evidenceFixture() {
  return {
    changedFiles: ["backend/routes/orders.js"],
    diffSummary: { additions: 2, deletions: 2 },
    repoMeta: { name: "demo" },
    changeSignals: {
      removedFields: new Set(["customerName"]),
      addedFields: new Set(["name"]),
      touchedSymbolNames: new Set(["getOrderById"]),
      touchedRoutes: [{ method: "GET", path: "/api/orders/:id" }],
    },
    contextItems: [
      {
        file: "frontend/src/OrderCard.js",
        relationshipType: "api_consumer",
        ring: "apis",
        score: 10,
        matches: [{ term: "customerName", kind: "removed_field", weight: 5, count: 1, lines: [8] }],
        lines: [8],
      },
      {
        file: "tests/orders.contract.test.js",
        relationshipType: "test",
        ring: "tests",
        score: 9,
        matches: [{ term: "customerName", kind: "removed_field", weight: 5, count: 1, lines: [14] }],
        lines: [14],
      },
    ],
  };
}

test("mock provider output validates against AnalysisResultSchema (AI response parsing)", async () => {
  const provider = new MockAnalysisProvider();
  const result = await provider.analyzeChange(evidenceFixture());
  const parsed = AnalysisResultSchema.safeParse(result);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("mock provider grounds every finding in the supplied evidence (no fabricated files)", async () => {
  const provider = new MockAnalysisProvider();
  const evidence = evidenceFixture();
  const result = await provider.analyzeChange(evidence);
  const knownFiles = new Set([...evidence.changedFiles, ...evidence.contextItems.map((c) => c.file)]);
  for (const item of [...result.impactedModules, ...result.untouchedFiles, ...result.documentationGaps]) {
    assert.ok(knownFiles.has(item.file), `unexpected file not in evidence: ${item.file}`);
  }
});

test("mock provider flags the removed-field consumer as an untouched, high-signal file", async () => {
  const provider = new MockAnalysisProvider();
  const result = await provider.analyzeChange(evidenceFixture());
  assert.ok(result.untouchedFiles.some((u) => u.file === "frontend/src/OrderCard.js"));
});

function additiveChangeFixture({ testCoversNewFunction }) {
  return {
    changedFiles: ["src/calculator.js", "tests/calculator.test.js"],
    diffSummary: { additions: 8, deletions: 0 },
    repoMeta: { name: "sample-app" },
    changeSignals: {
      removedFields: new Set(),
      addedFields: new Set(),
      addedFunctionNames: new Set(["power"]),
      removedFunctionNames: new Set(),
      touchedSymbolNames: new Set(["power"]),
      touchedRoutes: [],
    },
    contextItems: [],
    addedLinesByFile: {
      "src/calculator.js": ["export function power(base, exponent) {", "  return Math.pow(base, exponent);", "}"],
      "tests/calculator.test.js": testCoversNewFunction
        ? ['test("power", () => {', "  assert.equal(power(2, 10), 1024);", "});"]
        : [],
    },
  };
}

test("mock provider does not flag a missing test when the new function is exercised in the same diff", async () => {
  const provider = new MockAnalysisProvider();
  const result = await provider.analyzeChange(additiveChangeFixture({ testCoversNewFunction: true }));
  assert.equal(result.missingTests.length, 0);
  assert.match(result.intent, /power/);
});

test("mock provider flags a missing test when a new function has no test coverage anywhere", async () => {
  const provider = new MockAnalysisProvider();
  const result = await provider.analyzeChange(additiveChangeFixture({ testCoversNewFunction: false }));
  assert.ok(result.missingTests.some((t) => t.title.includes("power")));
});

test("mock provider generated patch validates against PatchProposalSchema", async () => {
  const provider = new MockAnalysisProvider();
  const evidence = evidenceFixture();
  const finding = {
    id: "f1",
    category: "missing_test",
    evidence: [{ file: "tests/orders.contract.test.js", lines: [14] }],
  };
  const patch = await provider.generatePatch(finding, evidence);
  const parsed = PatchProposalSchema.safeParse(patch);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.ok(patch.operations.length > 0);
});
