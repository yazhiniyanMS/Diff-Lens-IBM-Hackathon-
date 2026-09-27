// Browser port of server/lib/reviewBrief.js -- identical pipeline shape
// (git diff -> parse -> change signals -> repo context -> AI analysis ->
// risk-classified findings -> review radar graph -> session object), just
// driven by browserGit.js/browserContextEngine.js instead of a real git
// CLI + Node fs, and taking an already-constructed AIProvider instance
// (built from user-entered settings, see lib/aiProvider/browserProviderFactory.js)
// instead of reading one from environment variables.

import * as git from "./browserGit.js";
import { parseUnifiedDiff, summarizeDiff } from "./lib/diffParser.js";
import { extractChangeSignals, gatherContext } from "./browserContextEngine.js";
import { buildRadarGraph } from "./lib/relationshipGraph.js";
import { classifyRisk } from "./lib/riskModel.js";
import { hashContent } from "./browserPatch.js";

function id() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runAnalysis({ fs, dir, repoName, base, head, provider }) {
  await git.assertGitRepo(fs, dir);

  const diffText = await git.getDiff(fs, dir, base, head);
  const parsedFiles = parseUnifiedDiff(diffText);
  const diffSummary = summarizeDiff(parsedFiles);

  if (parsedFiles.length === 0) {
    return emptySession({ dir, base, head, diffText, diffSummary, provider });
  }

  const changeSignals = await extractChangeSignals(fs, dir, base, head, parsedFiles);
  const changedFileSet = new Set(changeSignals.changedFiles);
  const contextItems = await gatherContext(fs, dir, head, changeSignals, changedFileSet);

  const evidencePackage = {
    repoMeta: {
      name: repoName,
      base: await git.commitMeta(fs, dir, base),
      head: head === git.REF.WORKING_TREE || head === git.REF.STAGED ? { ref: head } : await git.commitMeta(fs, dir, head),
    },
    changedFiles: [...changedFileSet],
    diffSummary,
    diffFiles: parsedFiles.map((f) => ({
      path: f.newPath,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      hunks: f.hunks.map((h) => ({ header: h.header, lineCount: h.lines.length })),
    })),
    changeSignals: {
      removedFields: [...changeSignals.removedFields],
      addedFields: [...changeSignals.addedFields],
      addedFunctionNames: [...changeSignals.addedFunctionNames],
      removedFunctionNames: [...changeSignals.removedFunctionNames],
      touchedSymbolNames: [...changeSignals.touchedSymbolNames],
      touchedRoutes: changeSignals.touchedRoutes,
    },
    addedLinesByFile: Object.fromEntries(
      parsedFiles
        .filter((f) => !f.isBinary)
        .map((f) => [
          f.newPath,
          f.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.content)).slice(0, 60),
        ])
    ),
    contextItems: contextItems.map(({ file, relationshipType, ring, score, matches, lines }) => ({
      file,
      relationshipType,
      ring,
      score,
      matches,
      lines,
    })),
  };

  const analysis = await provider.analyzeChange({ ...evidencePackage, changeSignals });

  const fileSnapshots = await buildFileSnapshots(fs, dir, head, [...changedFileSet, ...contextItems.map((c) => c.file)]);

  const findings = buildFindings(analysis, evidencePackage);
  const radar = buildRadarGraph({ changedFiles: [...changedFileSet], contextItems: evidencePackage.contextItems, findings });

  return {
    id: id(),
    createdAt: new Date().toISOString(),
    repoName,
    base,
    head,
    provider: provider.name,
    diffText,
    diffSummary,
    parsedFiles: parsedFiles.map((f) => ({
      oldPath: f.oldPath,
      newPath: f.newPath,
      status: f.status,
      isBinary: f.isBinary,
      additions: f.additions,
      deletions: f.deletions,
      hunks: f.hunks,
    })),
    evidencePackage,
    analysis,
    findings,
    radar,
    fileSnapshots,
    patches: [],
  };
}

async function buildFileSnapshots(fs, dir, head, files) {
  const unique = [...new Set(files)];
  const snapshots = {};
  for (const file of unique) {
    try {
      const content = await git.readFileAtRef(fs, dir, head, file);
      snapshots[file] = await hashContent(content || "");
    } catch {
      snapshots[file] = await hashContent("");
    }
  }
  return snapshots;
}

function emptySession({ dir, base, head, diffText, diffSummary, provider }) {
  return {
    id: id(),
    createdAt: new Date().toISOString(),
    base,
    head,
    provider: provider.name,
    diffText,
    diffSummary,
    parsedFiles: [],
    evidencePackage: null,
    analysis: null,
    findings: [],
    radar: { center: [], rings: [], nodes: [], edges: [] },
    patches: [],
    empty: true,
  };
}

function makeFinding({ category, title, summary, provenance, evidence, actionable, extra }) {
  const draft = { category, ...extra };
  const { risk, ruleId, rationale } = classifyRisk(draft);
  return {
    id: id(),
    category,
    title,
    summary,
    risk,
    riskRuleId: ruleId,
    riskRationale: rationale,
    provenance,
    evidence: evidence || [],
    status: "needs_review",
    actionable: !!actionable,
  };
}

function buildFindings(analysis, evidencePackage) {
  const findings = [];
  const hasUntouchedConsumer = analysis.untouchedFiles.length > 0;

  for (const item of analysis.behavioralChanges) {
    findings.push(makeFinding({ category: "behavioral_change", title: "Behavior change", summary: item.summary, provenance: item.provenance, evidence: item.evidence, extra: {} }));
  }
  for (const item of analysis.apiContractChanges) {
    findings.push(makeFinding({ category: "api_contract_change", title: "API response changed", summary: item.summary, provenance: item.provenance, evidence: item.evidence, extra: { removedFieldStillReferenced: hasUntouchedConsumer } }));
  }
  for (const item of analysis.missingTests) {
    findings.push(makeFinding({ category: "missing_test", title: item.title, summary: item.rationale, provenance: "inference", evidence: item.evidence, actionable: true, extra: { contractTestExists: !!item.targetFile, contractTestUpdated: false } }));
  }
  for (const item of analysis.documentationGaps) {
    findings.push(makeFinding({ category: "documentation_gap", title: `Outdated docs in \`${item.file}\``, summary: item.issue, provenance: "inference", evidence: item.evidence, actionable: /(^|\/)docs\//i.test(item.file), extra: { contractChanged: analysis.apiContractChanges.length > 0 } }));
  }
  for (const item of analysis.securityConcerns) {
    findings.push(makeFinding({ category: "security_concern", title: "Security or validation concern", summary: item.summary, provenance: item.provenance, evidence: item.evidence, extra: {} }));
  }
  for (const item of analysis.backwardCompatibilityConcerns) {
    findings.push(makeFinding({ category: "backward_compatibility", title: "Breaks existing consumers", summary: item.summary, provenance: item.provenance, evidence: item.evidence, extra: {} }));
  }
  for (const item of analysis.untouchedFiles) {
    findings.push(makeFinding({ category: "untouched_consumer", title: `\`${item.file}\` wasn't updated`, summary: item.reason, provenance: "inference", evidence: item.evidence, extra: { referencesChangedSymbol: true } }));
  }

  return findings;
}
