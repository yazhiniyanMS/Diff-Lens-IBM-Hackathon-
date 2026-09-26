import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../server/lib/reviewBrief.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_REPO = path.join(__dirname, "..", "demo-repo");

// End-to-end coverage of the core workflow this whole product is built to
// demonstrate: repo -> diff -> analysis -> review brief -> radar -> finding
// -> evidence. Run against the real demo fixture (main -> the deliberately
// incomplete feature/simplify-order-response PR) so a regression in the
// "small diff, large blast radius" story is caught here, not just at demo time.

test("analyzing the demo repo's incomplete PR surfaces the full blast radius", async () => {
  const session = await runAnalysis({ repoPath: DEMO_REPO, base: "main", head: "feature/simplify-order-response" });

  // Deterministic facts
  assert.equal(session.diffSummary.filesChanged, 2);
  assert.deepEqual(session.diffSummary.modified.sort(), ["backend/models/order.js", "backend/routes/orders.js"]);
  assert.deepEqual(session.evidencePackage.changeSignals.removedFields, ["customerName"]);
  assert.deepEqual(session.evidencePackage.changeSignals.addedFields, ["name"]);

  const byCategory = (cat) => session.findings.filter((f) => f.category === cat);

  // The untouched frontend consumer and contract test must be surfaced
  const untouchedFiles = byCategory("untouched_consumer").map((f) => f.summary);
  assert.ok(session.findings.some((f) => f.evidence.some((e) => e.file === "frontend/src/OrderCard.js")), "should flag OrderCard.js");
  assert.ok(session.findings.some((f) => f.evidence.some((e) => e.file === "tests/orders.contract.test.js")), "should flag the contract test");

  // Missing test coverage for the changed contract
  const missingTests = byCategory("missing_test");
  assert.ok(missingTests.length > 0);
  assert.ok(missingTests.some((f) => f.risk === "high" || f.risk === "medium"));

  // Stale documentation
  const docGaps = byCategory("documentation_gap");
  const apiDoc = docGaps.find((f) => f.title.includes("docs/api/orders.md"));
  assert.ok(apiDoc, "should flag docs/api/orders.md as stale");
  assert.equal(apiDoc.actionable, true, "structured API doc should be actionable for Fix Mode");
  const readmeDoc = docGaps.find((f) => f.title.includes("README.md"));
  if (readmeDoc) assert.equal(readmeDoc.actionable, false, "free-form README should not be blindly patched");

  // Risk classification produced at least one high-risk finding
  assert.ok(session.findings.some((f) => f.risk === "high"));

  // Review Radar: changed files at center, related nodes across multiple rings
  assert.equal(session.radar.center.length, 2);
  const ringsUsed = new Set(session.radar.nodes.map((n) => n.ring));
  assert.ok(ringsUsed.has("apis"));
  assert.ok(ringsUsed.has("tests"));
  assert.ok(ringsUsed.has("docs"));
  assert.ok(session.radar.nodes.some((n) => n.status === "risk"));

  // Reviewer questions grounded in the change
  assert.ok(session.analysis.reviewQuestions.length > 0);
});

test("comparing a branch against itself yields an empty session, not an error", async () => {
  const session = await runAnalysis({ repoPath: DEMO_REPO, base: "main", head: "main" });
  assert.equal(session.empty, true);
  assert.deepEqual(session.findings, []);
});
