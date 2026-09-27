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
const code = (x) => `\`${x}\``;
function list(items, wrap = code) {
  const w = items.map(wrap);
  if (w.length <= 1) return w.join("");
  if (w.length === 2) return `${w[0]} and ${w[1]}`;
  return `${w.slice(0, -1).join(", ")}, and ${w[w.length - 1]}`;
}
const plural = (n, one, many) => (n === 1 ? one : many);
const route = (r) => `${r.method} ${r.path}`;

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
        summary: `The response shape changed: ${list(removed)} ${plural(removed.length, "was", "were")} removed and ${list(added)} added in ${list(changedFiles)}.`,
        provenance: "fact",
        evidence: changedFiles.map((f) => ({ file: f, lines: [], note: "Renames the field here" })),
      });
    } else if (addedFunctions.length) {
      behavioralChanges.push({
        summary: `New ${plural(addedFunctions.length, "function", "functions")} ${list(addedFunctions)} added in ${list(changedFiles)}.`,
        provenance: "fact",
        evidence: changedFiles.map((f) => ({ file: f, note: "Adds the function here" })),
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
          note: `Matches ${list(item.matches.map((m) => m.term))}`,
        },
      ],
    }));

    const apiContractChanges = [];
    if (routes.length && removed.length) {
      apiContractChanges.push({
        summary: `${list(routes.map(route))} now ${plural(routes.length, "returns", "return")} ${list(added)} instead of ${list(removed)}, changing the response contract.`,
        provenance: "fact",
        evidence: changedFiles.map((f) => ({ file: f, note: "Changes the endpoint's response here" })),
      });
    }

    const relatedTests = testItems.map((t) => ({ file: t.file, reason: describeReason(t) }));

    const missingTests = [];
    for (const t of testItems) {
      if (referencesRemoved(t)) {
        missingTests.push({
          title: `Update the contract test in ${code(t.file)}`,
          rationale: `This test still checks ${list(removed)}, which the response no longer includes. It will fail as-is, and it needs an assertion on ${list(added)} to keep the contract covered.`,
          targetFile: t.file,
          suggestedAssertions: added.map((f) => `expect(response.body).to.have.property('${f}')`),
          evidence: [{ file: t.file, lines: t.lines, note: `still references ${list(removed)}` }],
        });
      }
    }
    if (routes.length && !testItems.length) {
      missingTests.push({
        title: `Add a contract test for ${list(routes.map(route))}`,
        rationale: "No existing test checks this endpoint's response, so the new contract has no regression coverage.",
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
          evidence: changedFiles.map((f) => ({ file: f, note: `Defines or changes ${code(fn)}` })),
        });
      }
    }

    const documentationGaps = docItems
      .filter(referencesRemoved)
      .map((d) => ({
        file: d.file,
        issue: `Still documents ${list(removed)}, but the response now returns ${list(added)}.`,
        evidence: [{ file: d.file, lines: d.lines, note: "Still uses the old field name" }],
      }));

    const untouchedFiles = [...apiConsumers, ...testItems, ...docItems, ...serviceItems]
      .filter(referencesRemoved)
      .filter((item) => !changedFiles.includes(item.file))
      .map((item) => ({
        file: item.file,
        reason: `Not changed in this PR, but still uses ${list(removed)}.`,
        evidence: [{ file: item.file, lines: item.lines }],
      }));

    const backwardCompatibilityConcerns = [];
    if (removed.length && apiConsumers.some(referencesRemoved)) {
      backwardCompatibilityConcerns.push({
        summary: `Removing ${list(removed)} with no transition period breaks any consumer — internal or external — that still reads the old ${plural(removed.length, "name", "names")}.`,
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
      affectedWorkflows: apiConsumers.map((c) => `User-facing flow in ${code(c.file)}`),
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
    return `Renames the response ${plural(removed.length, "field", "fields")} ${list(removed)} to ${list(added)} on ${list(routes.map(route))}, most likely to simplify the API's naming.`;
  }
  if (removed.length && added.length) {
    return `Renames ${list(removed)} to ${list(added)} in ${list(changedFiles)}.`;
  }
  if (addedFunctions.length) {
    return `Adds ${plural(addedFunctions.length, "the function", "the functions")} ${list(addedFunctions)} in ${list(changedFiles)}.`;
  }
  return `Changes ${list(changedFiles)} (+${diffSummary.additions} / −${diffSummary.deletions} lines). No field-level contract change was detected.`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeReason(item) {
  const kinds = item.matches.map((m) => m.kind);
  if (kinds.includes("removed_field")) return "Uses a field this change removed from the response.";
  if (kinds.includes("route")) return "Calls the same endpoint this change touches.";
  if (kinds.includes("symbol")) return "Uses a function this change touches.";
  if (kinds.includes("import")) return "Imports a file this change touches.";
  return "Mentions the changed code.";
}

function buildReviewQuestions({ removed, added, routes, apiConsumers, testItems, docItems }) {
  const qs = [];
  if (removed.length && added.length) {
    qs.push(`Is renaming ${list(removed)} to ${list(added)} intentional, and should it ship now or behind a compatibility shim?`);
  }
  if (apiConsumers.length) {
    qs.push(`${list(apiConsumers.map((c) => c.file))} still ${plural(apiConsumers.length, "reads", "read")} the old field. Should this PR update ${plural(apiConsumers.length, "it", "them")}, or is a follow-up planned before merge?`);
  }
  if (testItems.length) {
    qs.push(`Should ${list(testItems.map((t) => t.file))} be updated in this PR so the contract stays tested?`);
  }
  if (docItems.length) {
    qs.push(`Should ${list(docItems.map((d) => d.file))} be updated before merge so the API docs match?`);
  }
  if (routes.length) {
    qs.push(`Is this a breaking API change? Should ${list(routes.map(route))} get a new version, or accept both field names during a migration window?`);
  }
  if (!qs.length) {
    qs.push("No contract change detected — does the diff match what the PR description says it does?");
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
    summary: `Update ${code(file)} to document ${list(added)} instead of ${list(removed)}.`,
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
    summary: `Add an assertion for ${code(added[0])} to the contract test in ${code(file)}.`,
    unifiedDiff: `--- a/${file}\n+++ b/${file}\n@@ add assertion for new contract field @@\n${assertion}`,
    targetFiles: [file],
    rationale: "The response contract changed; the test should assert the new field is present so coverage isn't silently lost.",
    operations: [{ file, kind: "insert_after_match", match: removed[0] || "items", insertText: assertion }],
  };
}
