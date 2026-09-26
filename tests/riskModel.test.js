import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRisk } from "../server/lib/riskModel.js";

test("removed field still referenced by a consumer is high risk", () => {
  const { risk, ruleId } = classifyRisk({ category: "api_contract_change", removedFieldStillReferenced: true });
  assert.equal(risk, "high");
  assert.equal(ruleId, "removed-field-referenced-by-consumer");
});

test("existing contract test not updated is high risk", () => {
  const { risk, ruleId } = classifyRisk({ category: "missing_test", contractTestExists: true, contractTestUpdated: false });
  assert.equal(risk, "high");
  assert.equal(ruleId, "contract-test-not-updated");
});

test("no test coverage at all for changed endpoint is medium risk", () => {
  const { risk, ruleId } = classifyRisk({ category: "missing_test", contractTestExists: false });
  assert.equal(risk, "medium");
  assert.equal(ruleId, "no-test-coverage-for-changed-endpoint");
});

test("stale docs after a contract change is medium risk", () => {
  const { risk } = classifyRisk({ category: "documentation_gap", contractChanged: true });
  assert.equal(risk, "medium");
});

test("unmatched category falls back to informational", () => {
  const { risk, ruleId } = classifyRisk({ category: "behavioral_change" });
  assert.equal(risk, "informational");
  assert.equal(ruleId, "default-informational");
});

test("backward compatibility concerns are high risk", () => {
  const { risk } = classifyRisk({ category: "backward_compatibility" });
  assert.equal(risk, "high");
});
