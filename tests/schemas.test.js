import { test } from "node:test";
import assert from "node:assert/strict";
import { safeParseAnalysis, PatchProposalSchema, FindingSchema } from "../server/lib/schemas.js";

const VALID_ANALYSIS = {
  intent: "Rename a field",
  intentProvenance: "inference",
  behavioralChanges: [{ summary: "x changed", provenance: "fact", evidence: [{ file: "a.js", lines: [1], note: "n" }] }],
};

test("safeParseAnalysis accepts a minimal valid AI response and fills defaults", () => {
  const result = safeParseAnalysis(VALID_ANALYSIS);
  assert.equal(result.success, true);
  assert.deepEqual(result.data.affectedWorkflows, []);
  assert.deepEqual(result.data.reviewQuestions, []);
});

test("safeParseAnalysis rejects a malformed AI response (missing required fields)", () => {
  const result = safeParseAnalysis({ behavioralChanges: "not-an-array" });
  assert.equal(result.success, false);
});

test("safeParseAnalysis rejects an invalid provenance value", () => {
  const result = safeParseAnalysis({ ...VALID_ANALYSIS, intentProvenance: "guess" });
  assert.equal(result.success, false);
});

test("PatchProposalSchema requires targetFiles and defaults operations to []", () => {
  const parsed = PatchProposalSchema.safeParse({
    findingId: "f1",
    summary: "s",
    unifiedDiff: "",
    targetFiles: ["a.js"],
    rationale: "r",
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.operations, []);
});

test("FindingSchema rejects an unknown status", () => {
  const parsed = FindingSchema.safeParse({
    id: "1",
    category: "x",
    title: "t",
    summary: "s",
    risk: "high",
    riskRuleId: "r",
    riskRationale: "rr",
    provenance: "fact",
    status: "archived",
  });
  assert.equal(parsed.success, false);
});
