import { AIProvider } from "./AIProvider.js";

/**
 * Deterministic, evidence-grounded "AI-shaped" provider used for
 * development and for the hackathon demo when no IBM Bob endpoint is
 * configured. It does NOT call any external model. Every finding it
 * produces is derived directly from the structured evidence package
 * (diff signals + repository context) built by the deterministic pipeline
 * -- it never invents files, symbols, or relationships that aren't in the
 * evidence. This keeps the UI and evidence-trail testable without spending
 * real API calls, and gives judges a clear seam where a real IBM/Bob call
 * would slot in (see bobProvider.js).
 */
export class MockAnalysisProvider extends AIProvider {
  get name() {
    return "mock-heuristic";
  }

  async analyzeChange(evidence) {
    const { changeSignals, contextItems, diffSummary, changedFiles, repoMeta } = evidence;
    const removed = [...changeSignals.removedFields];
    const added = [...changeSignals.addedFields];
    const routes = changeSignals.touchedRoutes;
    const addedFunctions = [...(changeSignals.addedFunctionNames || [])];
    const addedLinesByFile = evidence.addedLinesByFile || {};
    const isFieldRename = removed.length > 0 && added.length > 0;

    const intent = buildIntent({ removed, added, routes, diffSummary, changedFiles, addedFunctions });

    const behavioralChanges = [];
    if (isFieldRename) {
      behavioralChanges.push({
        summary: `The response/data shape changed: field(s) [${removed.join(", ")}] were removed and [${added.join(", ")}] were introduced in ${changedFiles.join(", ")}.`,
        provenance: "fact",
        evidence: changedFiles.map((f) => ({ file: f, lines: [], note: "field rename observed in diff" })),
      });
    } else if (addedFunctions.length) {
      behavioralChanges.push({
        summary: `New function(s) [${addedFunctions.join(", ")}] added in ${changedFiles.join(", ")}.`,
        provenance: "fact",
        evidence: changedFiles.map((f) => ({ file: f, note: "new function observed in diff" })),
      });
    }

    const apiConsumers = contextItems.filter((c) => c.relationshipType === "api_consumer");
    const testItems = contextItems.filter((c) => c.relationshipType === "test");
    const docItems = contextItems.filter((c) => c.relationshipType === "documentation");
    const serviceItems = contextItems.filter((c) => c.relationshipType === "service");

    const referencesRemoved = (item) =>
      item.matches.some((m) => m.kind === "removed_field");

    const impactedModules = contextItems.map((item) => ({
      file: item.file,
      relationship: item.relationshipType,
      reason: describeReason(item),
      provenance: "inference",
      evidence: [
        {
          file: item.file,
          lines: item.lines,
          note: `Matched terms: ${item.matches.map((m) => `${m.term} (${m.kind})`).join(", ")}`,
        },
      ],
    }));

    const apiContractChanges = [];
    if (routes.length && removed.length) {
      apiContractChanges.push({
        summary: `Endpoint(s) ${routes.map((r) => `${r.method} ${r.path}`).join(", ")} changed their response contract by replacing field(s) [${removed.join(", ")}] with [${added.join(", ")}].`,
        provenance: "fact",
        evidence: changedFiles.map((f) => ({ file: f, note: "route + field change observed in diff" })),
      });
    }

    const relatedTests = testItems.map((t) => ({ file: t.file, reason: describeReason(t) }));

    const missingTests = [];
    for (const t of testItems) {
      if (referencesRemoved(t)) {
        missingTests.push({
          title: `Update contract test in ${t.file} for the new response shape`,
          rationale: `${t.file} asserts on field(s) [${removed.join(", ")}] that no longer exist in the response. Left as-is this test will fail (best case) or needs a new assertion on [${added.join(", ")}] to keep the contract enforced (worst case: silently deleted coverage).`,
          targetFile: t.file,
          suggestedAssertions: added.map((f) => `expect(response.body).to.have.property('${f}')`),
          evidence: [{ file: t.file, lines: t.lines, note: `references removed field(s): ${removed.join(", ")}` }],
        });
      }
    }
    if (routes.length && !testItems.length) {
      missingTests.push({
        title: `Add a contract test for ${routes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
        rationale: "No existing test file references this endpoint's response shape; the new contract has no regression coverage.",
        targetFile: "",
        suggestedAssertions: added.map((f) => `expect(response.body).to.have.property('${f}')`),
        evidence: changedFiles.map((f) => ({ file: f })),
      });
    }

    // Generic coverage check for any newly added function, independent of
    // the field-rename pattern above: was it referenced by a test file
    // changed in this same diff, or by an existing test file elsewhere in
    // the repo? This is what keeps an ordinary additive PR (not just the
    // API-contract-change scenario) from producing an empty, unhelpful
    // review brief.
    const changedTestLines = changedFiles
      .filter((f) => /test|spec|__tests__/i.test(f))
      .flatMap((f) => addedLinesByFile[f] || []);
    for (const fn of addedFunctions) {
      const referencedIn = (lines) => lines.some((l) => new RegExp(`\\b${escapeRegex(fn)}\\b`).test(l));
      const coveredBySameDiffTest = referencedIn(changedTestLines);
      const coveredByExistingTest = testItems.some((t) => t.matches.some((m) => m.kind === "symbol" && m.term === fn));
      if (!coveredBySameDiffTest && !coveredByExistingTest) {
        missingTests.push({
          title: `Add a test for new function \`${fn}\``,
          rationale: `\`${fn}\` was added in this diff but no test (in this PR or elsewhere in the repo) appears to exercise it by name.`,
          targetFile: "",
          suggestedAssertions: [`assert.equal(${fn}(/* inputs */), /* expected */)`],
          evidence: changedFiles.map((f) => ({ file: f, note: `defines/touches ${fn}` })),
        });
      }
    }

    const documentationGaps = docItems
      .filter(referencesRemoved)
      .map((d) => ({
        file: d.file,
        issue: `Documents field(s) [${removed.join(", ")}] which no longer appear in the actual response; now [${added.join(", ")}] instead.`,
        evidence: [{ file: d.file, lines: d.lines, note: "stale field name in docs" }],
      }));

    const untouchedFiles = [...apiConsumers, ...testItems, ...docItems, ...serviceItems]
      .filter(referencesRemoved)
      .filter((item) => !changedFiles.includes(item.file))
      .map((item) => ({
        file: item.file,
        reason: `Not modified by this PR but references the removed field(s) [${removed.join(", ")}]. ${describeReason(item)}`,
        evidence: [{ file: item.file, lines: item.lines }],
      }));

    const backwardCompatibilityConcerns = [];
    if (removed.length && apiConsumers.some(referencesRemoved)) {
      backwardCompatibilityConcerns.push({
        summary: `Removing field(s) [${removed.join(", ")}] without a transition period breaks any consumer (internal or external) still reading the old field name, with no deprecation window.`,
        provenance: "inference",
        evidence: apiConsumers.filter(referencesRemoved).map((c) => ({ file: c.file, lines: c.lines })),
      });
    }

    const securityConcerns = [];

    const reviewQuestions = buildReviewQuestions({ removed, added, routes, apiConsumers, testItems, docItems });

    return {
      intent,
      intentProvenance: "inference",
      behavioralChanges,
      affectedWorkflows: apiConsumers.map((c) => `User-facing flow touching ${c.file}`),
      impactedModules,
      apiContractChanges,
      schemaInterfaceImpact: [],
      relatedTests,
      missingTests,
      documentationGaps,
      securityConcerns,
      backwardCompatibilityConcerns,
      untouchedFiles,
      reviewQuestions,
      meta: { provider: this.name, repoMeta },
    };
  }

  async generatePatch(finding, evidence) {
    if (finding.category === "documentation_gap") {
      return generateDocPatch(finding, evidence);
    }
    if (finding.category === "missing_test") {
      return generateTestPatch(finding, evidence);
    }
    return {
      findingId: finding.id,
      summary: `No deterministic patch template available for category "${finding.category}" in the mock provider.`,
      unifiedDiff: "",
      targetFiles: [],
      rationale: "This category requires model-generated code changes; connect an AI provider (e.g. IBM Bob) to enable it.",
      operations: [],
    };
  }

  async assessEquivalence(beforeCode, afterCode, _context) {
    const changed = beforeCode.trim() !== afterCode.trim();
    return {
      likelyEquivalent: !changed,
      notes: changed
        ? "Code differs; the mock provider cannot verify semantic equivalence. Run the repository's test suite to confirm behavior is preserved."
        : "No textual change detected.",
    };
  }
}

function buildIntent({ removed, added, routes, diffSummary, changedFiles, addedFunctions = [] }) {
  if (removed.length && added.length && routes.length) {
    return `Rename/restructure the response field(s) [${removed.join(", ")}] to [${added.join(", ")}] on ${routes
      .map((r) => `${r.method} ${r.path}`)
      .join(", ")}, apparently to simplify the API's naming.`;
  }
  if (removed.length && added.length) {
    return `Rename field(s) [${removed.join(", ")}] to [${added.join(", ")}] in ${changedFiles.join(", ")}.`;
  }
  if (addedFunctions.length) {
    return `Add new function(s) [${addedFunctions.join(", ")}] in ${changedFiles.join(", ")}.`;
  }
  return `Modify ${changedFiles.join(", ")} (${diffSummary.additions} additions, ${diffSummary.deletions} deletions); no clear field-level contract signal detected.`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeReason(item) {
  const kinds = item.matches.map((m) => m.kind);
  if (kinds.includes("removed_field")) return "References a field name that this PR removed from the response.";
  if (kinds.includes("route")) return "References the same route/endpoint touched by this PR.";
  if (kinds.includes("symbol")) return "References a function/symbol touched by this PR.";
  if (kinds.includes("import")) return "Imports or is named after a file touched by this PR.";
  return "Textually related to the changed code.";
}

function buildReviewQuestions({ removed, added, routes, apiConsumers, testItems, docItems }) {
  const qs = [];
  if (removed.length && added.length) {
    qs.push(
      `Is the rename from [${removed.join(", ")}] to [${added.join(", ")}] intentional, and is it meant to ship in this PR or behind a compatibility shim?`
    );
  }
  if (apiConsumers.length) {
    qs.push(
      `${apiConsumers.map((c) => c.file).join(", ")} still reads the old field name — should this PR update them, or is a follow-up PR planned before merge?`
    );
  }
  if (testItems.length) {
    qs.push(`Should ${testItems.map((t) => t.file).join(", ")} be updated in this PR so the contract test still enforces the response shape?`);
  }
  if (docItems.length) {
    qs.push(`Should ${docItems.map((d) => d.file).join(", ")} be updated before merge so published API docs match the new response shape?`);
  }
  if (routes.length) {
    qs.push(`Is this a versioned/breaking API change? Should ${routes.map((r) => r.path).join(", ")} bump a version or support both field names during a migration window?`);
  }
  if (!qs.length) {
    qs.push("No high-signal contract change detected — confirm the diff's intent matches the PR description.");
  }
  return qs;
}

function generateDocPatch(finding, evidence) {
  const removed = [...evidence.changeSignals.removedFields];
  const added = [...evidence.changeSignals.addedFields];
  const file = finding.evidence?.[0]?.file;
  if (!file || !removed.length || !added.length) {
    return { findingId: finding.id, summary: "Insufficient evidence to generate a doc patch.", unifiedDiff: "", targetFiles: [], rationale: "", operations: [] };
  }
  const pairs = removed.map((r, i) => [r, added[i] || added[added.length - 1]]);
  const diffLines = [`--- a/${file}`, `+++ b/${file}`, `@@ doc field name update @@`, ...pairs.flatMap(([r, a]) => [`-${r}`, `+${a}`])];
  return {
    findingId: finding.id,
    summary: `Update ${file} to reference the new field name(s) [${added.join(", ")}] instead of [${removed.join(", ")}].`,
    unifiedDiff: diffLines.join("\n"),
    targetFiles: [file],
    rationale: "Deterministic find/replace of the documented field name based on the diff's field rename.",
    operations: pairs.map(([find, replace]) => ({ file, kind: "replace_all", find, replace })),
  };
}

function generateTestPatch(finding, evidence) {
  const file = finding.evidence?.[0]?.file;
  const added = [...evidence.changeSignals.addedFields];
  const removed = [...evidence.changeSignals.removedFields];
  if (!file || !added.length) {
    return { findingId: finding.id, summary: "Insufficient evidence to generate a test patch.", unifiedDiff: "", targetFiles: [], rationale: "", operations: [] };
  }
  const assertion = `  assert.equal(typeof body.${added[0]}, "string", "expected ${added[0]} field per updated API contract");`;
  return {
    findingId: finding.id,
    summary: `Add an assertion for the new field "${added[0]}" alongside the existing contract test in ${file}.`,
    unifiedDiff: `--- a/${file}\n+++ b/${file}\n@@ add assertion for new contract field @@\n${assertion}`,
    targetFiles: [file],
    rationale: "The response contract changed; the test should assert the new field is present so coverage isn't silently lost.",
    operations: [{ file, kind: "insert_after_match", match: removed[0] || "items", insertText: assertion }],
  };
}
