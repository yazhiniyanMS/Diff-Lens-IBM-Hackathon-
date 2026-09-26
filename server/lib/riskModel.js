/**
 * Rule-backed, descriptive risk categorization. DiffLens deliberately does
 * not invent numeric confidence scores -- each finding gets one of four
 * explicit categories (informational/low/medium/high) plus a human-readable
 * rule explaining *why* it was categorized that way, so a reviewer can
 * disagree with the rule, not just the label.
 */

const RULES = [
  {
    id: "removed-field-referenced-by-consumer",
    test: (f) => f.category === "api_contract_change" && f.removedFieldStillReferenced,
    risk: "high",
    reason:
      "A field was removed/renamed in the API response and a consumer file still references the old field name — this will read as undefined/broken at runtime.",
  },
  {
    id: "contract-test-not-updated",
    test: (f) => f.category === "missing_test" && f.contractTestExists && !f.contractTestUpdated,
    risk: "high",
    reason:
      "An existing contract test asserts the old response shape and was not updated alongside the API change — it will fail, or worse, silently stop catching real regressions if the assertion is loose.",
  },
  {
    id: "no-test-coverage-for-changed-endpoint",
    test: (f) => f.category === "missing_test" && !f.contractTestExists,
    risk: "medium",
    reason: "No existing test references this changed endpoint/response shape — the change currently has zero regression coverage.",
  },
  {
    id: "docs-stale-after-contract-change",
    test: (f) => f.category === "documentation_gap" && f.contractChanged,
    risk: "medium",
    reason:
      "Public API documentation still describes the pre-change response shape, which will mislead any consumer implementing against the docs.",
  },
  {
    id: "untouched-file-references-changed-symbol",
    test: (f) => f.category === "untouched_consumer" && f.referencesChangedSymbol,
    risk: "medium",
    reason:
      "This file was not part of the diff but textually references a symbol/field the diff changed, so its behavior may silently depend on the old shape.",
  },
  {
    id: "security-input-validation",
    test: (f) => f.category === "security_concern",
    risk: "medium",
    reason: "The changed code path handles external input/output without an accompanying validation or sanitization change visible in the diff.",
  },
  {
    id: "backward-compatibility-break",
    test: (f) => f.category === "backward_compatibility",
    risk: "high",
    reason: "The change alters a response/interface shape relied on outside this diff without a versioning or migration path.",
  },
  {
    id: "default-informational",
    test: () => true,
    risk: "informational",
    reason: "Observed from the diff or repository context; no rule matched a higher-risk pattern.",
  },
];

export function classifyRisk(findingDraft) {
  for (const rule of RULES) {
    if (rule.test(findingDraft)) {
      return { risk: rule.risk, ruleId: rule.id, rationale: rule.reason };
    }
  }
  return { risk: "informational", ruleId: "default-informational", rationale: "No rule matched." };
}

export const RISK_LEVELS = ["informational", "low", "medium", "high"];
