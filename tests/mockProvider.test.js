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
