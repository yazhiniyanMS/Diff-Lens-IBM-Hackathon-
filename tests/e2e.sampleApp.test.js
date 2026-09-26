import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../server/lib/reviewBrief.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_APP = path.join(__dirname, "..", "sample-app");

// sample-app is the deliberate opposite of demo-repo: an ordinary,
// well-tested, well-documented additive change. This is what keeps the
// "small diff, large blast radius" demo from being the only diff shape
// DiffLens has ever seen -- and guards against the mock provider
// regressing to producing an empty, unhelpful brief for a normal PR.
test("analyzing sample-app's well-tested feature branch produces a useful, low-noise brief", async () => {
  const session = await runAnalysis({ repoPath: SAMPLE_APP, base: "main", head: "feature/add-power-function" });

  assert.equal(session.diffSummary.filesChanged, 3);
  assert.deepEqual(session.evidencePackage.changeSignals.addedFunctionNames, ["power"]);

  // Intent should mention the actual new function, not a generic fallback.
  assert.match(session.analysis.intent, /power/);

  // Because the test and docs were updated in the SAME diff, there should
  // be no missing-test or documentation-gap findings -- a well-formed PR
  // should not be flagged just for existing.
  const missingTests = session.findings.filter((f) => f.category === "missing_test");
  assert.equal(missingTests.length, 0);

  // It should still say *something* useful rather than nothing at all.
  assert.ok(session.findings.length > 0);
  assert.ok(session.findings.every((f) => f.risk === "informational" || f.risk === "low"));
});
