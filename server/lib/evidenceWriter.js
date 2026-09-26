import fs from "node:fs";
import path from "node:path";

/**
 * Renders the hackathon evidence trail (docs/bob-code-review/*.md) from a
 * real, completed analysis session. Nothing here is fabricated: every
 * section either quotes a deterministic repository fact (diff stats,
 * file paths, matched terms) or a specific AI-derived finding, and each
 * is labeled which one it is.
 */
export function writeEvidenceDocs(session, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    "change-intent.md": renderChangeIntent(session),
    "impact-analysis.md": renderImpactAnalysis(session),
    "review-questions.md": renderReviewQuestions(session),
    "missing-tests.md": renderMissingTests(session),
    "session-summary.md": renderSessionSummary(session),
  };
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, content);
    written.push(p);
  }
  return written;
}

function fmtEvidence(ev) {
  if (!ev || !ev.length) return "_(no direct evidence attached)_";
  return ev.map((e) => `- \`${e.file}\`${e.lines?.length ? ` (lines ${e.lines.join(", ")})` : ""}${e.note ? ` — ${e.note}` : ""}`).join("\n");
}

function renderChangeIntent(session) {
  const a = session.analysis;
  if (!a) return "# Change Intent\n\n_No analysis available (empty diff)._\n";
  return `# Change Intent

**Repository:** ${session.evidencePackage.repoMeta.name}
**Comparing:** \`${session.base}\` → \`${session.head}\`
**Analysis provider:** ${session.provider}

## Deterministic facts (from the diff, not AI-derived)

- Files changed: ${session.diffSummary.filesChanged}
- Additions / deletions: +${session.diffSummary.additions} / -${session.diffSummary.deletions}
- Modified: ${session.diffSummary.modified.join(", ") || "none"}
- Added: ${session.diffSummary.added.join(", ") || "none"}
- Deleted: ${session.diffSummary.deleted.join(", ") || "none"}
- Removed field name(s) observed in the diff: ${session.evidencePackage.changeSignals.removedFields.join(", ") || "none"}
- Added field name(s) observed in the diff: ${session.evidencePackage.changeSignals.addedFields.join(", ") || "none"}

## AI-inferred functional intent

> ${a.intent}

_Provenance: ${a.intentProvenance}._

## Behavioral changes

${a.behavioralChanges.map((b) => `- **[${b.provenance}]** ${b.summary}\n${fmtEvidence(b.evidence)}`).join("\n\n") || "_None identified._"}
`;
}

function renderImpactAnalysis(session) {
  const a = session.analysis;
  if (!a) return "# Impact Analysis\n\n_No analysis available (empty diff)._\n";
  const radar = session.radar;
  const byRing = {};
  for (const n of radar.nodes) {
    byRing[n.ring] = byRing[n.ring] || [];
    byRing[n.ring].push(n);
  }
  return `# Impact Analysis

## Blast radius summary

Changed files: **${radar.center.length}** — Related nodes discovered: **${radar.nodes.length}**

${Object.entries(byRing)
  .map(([ring, nodes]) => `- **${ring}** (${nodes.length}): ${nodes.map((n) => `${n.file} [${n.status}]`).join(", ")}`)
  .join("\n") || "_No related nodes found._"}

## API & contract changes

${a.apiContractChanges.map((c) => `- **[${c.provenance}]** ${c.summary}\n${fmtEvidence(c.evidence)}`).join("\n\n") || "_None identified._"}

## Impacted modules

${a.impactedModules.map((m) => `- \`${m.file}\` (${m.relationship}) — ${m.reason}`).join("\n") || "_None identified._"}

## Backward compatibility concerns

${a.backwardCompatibilityConcerns.map((c) => `- **[${c.provenance}]** ${c.summary}\n${fmtEvidence(c.evidence)}`).join("\n\n") || "_None identified._"}

## Suspiciously untouched files

${a.untouchedFiles.map((u) => `- \`${u.file}\` — ${u.reason}\n${fmtEvidence(u.evidence)}`).join("\n\n") || "_None identified._"}
`;
}

function renderReviewQuestions(session) {
  const a = session.analysis;
  if (!a) return "# Reviewer Questions\n\n_No analysis available (empty diff)._\n";
  return `# Reviewer Questions

Concrete questions a human reviewer should resolve before approving this PR,
derived from the repository evidence above (not generic AI review filler).

${a.reviewQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}
`;
}

function renderMissingTests(session) {
  const a = session.analysis;
  if (!a) return "# Missing Tests\n\n_No analysis available (empty diff)._\n";
  return `# Missing Tests

${a.missingTests
  .map(
    (t) => `## ${t.title}

**Why:** ${t.rationale}
${t.targetFile ? `**Target file:** \`${t.targetFile}\`` : "**Target file:** _(new test file needed)_"}

Suggested assertions:
${t.suggestedAssertions.map((s) => `- \`${s}\``).join("\n") || "_(none suggested)_"}

Evidence:
${fmtEvidence(t.evidence)}
`
  )
  .join("\n---\n\n") || "_No missing tests identified._"}
`;
}

function renderSessionSummary(session) {
  const findingCounts = session.findings.reduce((acc, f) => {
    acc[f.risk] = (acc[f.risk] || 0) + 1;
    return acc;
  }, {});
  return `# Session Summary

**Session ID:** ${session.id}
**Created:** ${session.createdAt}
**Repository:** ${session.evidencePackage?.repoMeta?.name || session.repoPath}
**Comparison:** \`${session.base}\` → \`${session.head}\`
**AI provider:** ${session.provider}

## Analysis flow

1. **Deterministic diff parse** — \`git diff ${session.base} ${session.head}\` parsed into ${session.parsedFiles.length} changed file(s), ${session.diffSummary.additions} additions / ${session.diffSummary.deletions} deletions.
2. **Change signal extraction** — removed/added field names, touched functions/routes extracted from before/after file content.
3. **Repository context discovery** — ${session.evidencePackage?.contextItems?.length || 0} related file(s) ranked by textual/structural relevance to the change signals.
4. **AI intent & impact analysis** (${session.provider}) — produced intent, behavioral changes, contract/schema impact, missing tests, documentation gaps, and reviewer questions, each tagged fact vs. inference.
5. **Risk classification** — ${session.findings.length} finding(s) generated and rule-classified: ${Object.entries(findingCounts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "none"}.
6. **Review Radar** — ${session.radar.nodes.length} related node(s) rendered across ${session.radar.rings.length} rings around ${session.radar.center.length} changed file(s).

## Human-approved review comments

_(Populate this section from the "Generate Reviewer Summary" action in the UI once findings have been triaged as Accepted/Dismissed — DiffLens does not auto-post anything.)_
`;
}
