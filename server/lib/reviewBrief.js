import crypto from "node:crypto";
import * as git from "./git.js";
import { parseUnifiedDiff, summarizeDiff } from "./diffParser.js";
import { extractChangeSignals, gatherContext } from "./contextEngine.js";
import { buildRadarGraph } from "./relationshipGraph.js";
import { classifyRisk } from "./riskModel.js";
import { getAIProvider } from "./aiProvider/index.js";
import { hashContent } from "./patch/validator.js";

function id() {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * The full DiffLens pipeline:
 *   git diff -> parse -> change signals -> repo context -> AI analysis
 *   -> risk-classified findings -> review radar graph -> session object.
 *
 * Deterministic steps (git, parsing, symbol/context extraction, risk
 * rules) never depend on the AI provider; the AI provider only interprets
 * facts this pipeline already established.
 */
export async function runAnalysis({ repoPath, base, head }) {
  await git.assertGitRepo(repoPath);

  const diffText = await git.getDiff(repoPath, base, head);
  const parsedFiles = parseUnifiedDiff(diffText);
  const diffSummary = summarizeDiff(parsedFiles);

  if (parsedFiles.length === 0) {
    return emptySession({ repoPath, base, head, diffText, diffSummary });
  }

  const changeSignals = await extractChangeSignals(repoPath, base, head, parsedFiles);
  const changedFileSet = new Set(changeSignals.changedFiles);
  const contextItems = await gatherContext(repoPath, head, changeSignals, changedFileSet);

  const evidencePackage = {
    repoMeta: {
      name: await git.getRepoName(repoPath),
      base: await git.commitMeta(repoPath, base),
      head: head === git.REF.WORKING_TREE || head === git.REF.STAGED ? { ref: head } : await git.commitMeta(repoPath, head),
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
    // Capped added-line text per changed file, so heuristics (and any real
    // LLM provider) can tell whether a new symbol was actually exercised
    // by a test/doc file changed in this SAME diff -- contextItems only
    // covers files outside the diff, so this is the only way to see
    // "the PR added the function AND its test in one commit" evidence.
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

  const provider = getAIProvider();
  const analysis = await provider.analyzeChange({
    ...evidencePackage,
    changeSignals: changeSignals, // pass Set-backed version too for provider convenience
  });

  const fileSnapshots = await buildFileSnapshots(repoPath, head, [
    ...changedFileSet,
    ...contextItems.map((c) => c.file),
  ]);

  const findings = buildFindings(analysis, evidencePackage);
  const radar = buildRadarGraph({
    changedFiles: [...changedFileSet],
    contextItems: evidencePackage.contextItems,
    findings,
  });

  const session = {
    id: id(),
    createdAt: new Date().toISOString(),
    repoPath,
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
    verifications: [],
  };

  return session;
}

async function buildFileSnapshots(repoPath, head, files) {
  const unique = [...new Set(files)];
  const snapshots = {};
  for (const file of unique) {
    try {
      const content = await git.readFileAtRef(repoPath, head, file);
      snapshots[file] = hashContent(content || "");
    } catch {
      snapshots[file] = hashContent("");
    }
  }
  return snapshots;
}

function emptySession({ repoPath, base, head, diffText, diffSummary }) {
  return {
    id: id(),
    createdAt: new Date().toISOString(),
    repoPath,
    base,
    head,
    provider: getAIProvider().name,
    diffText,
    diffSummary,
    parsedFiles: [],
    evidencePackage: null,
    analysis: null,
    findings: [],
    radar: { center: [], rings: [], nodes: [], edges: [] },
    patches: [],
    verifications: [],
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
    findings.push(
      makeFinding({
        category: "behavioral_change",
        title: "Behavioral change",
        summary: item.summary,
        provenance: item.provenance,
        evidence: item.evidence,
        extra: {},
      })
    );
  }

  for (const item of analysis.apiContractChanges) {
    findings.push(
      makeFinding({
        category: "api_contract_change",
        title: "API contract change",
        summary: item.summary,
        provenance: item.provenance,
        evidence: item.evidence,
        extra: { removedFieldStillReferenced: hasUntouchedConsumer },
      })
    );
  }

  for (const item of analysis.missingTests) {
    findings.push(
      makeFinding({
        category: "missing_test",
        title: item.title,
        summary: item.rationale,
        provenance: "inference",
        evidence: item.evidence,
        actionable: true,
        extra: {
          contractTestExists: !!item.targetFile,
          contractTestUpdated: false,
        },
      })
    );
  }

  for (const item of analysis.documentationGaps) {
    findings.push(
      makeFinding({
        category: "documentation_gap",
        title: `Stale documentation: ${item.file}`,
        summary: item.issue,
        provenance: "inference",
        evidence: item.evidence,
        // Only offer an automated patch for structured API docs (docs/**).
        // A blind find/replace on free-form prose (e.g. README.md) can
        // mangle surrounding sentences, not just the documented field name.
        actionable: /(^|\/)docs\//i.test(item.file),
        extra: { contractChanged: analysis.apiContractChanges.length > 0 },
      })
    );
  }

  for (const item of analysis.securityConcerns) {
    findings.push(
      makeFinding({
        category: "security_concern",
        title: "Security / validation concern",
        summary: item.summary,
        provenance: item.provenance,
        evidence: item.evidence,
        extra: {},
      })
    );
  }

  for (const item of analysis.backwardCompatibilityConcerns) {
    findings.push(
      makeFinding({
        category: "backward_compatibility",
        title: "Backward compatibility concern",
        summary: item.summary,
        provenance: item.provenance,
        evidence: item.evidence,
        extra: {},
      })
    );
  }

  for (const item of analysis.untouchedFiles) {
    findings.push(
      makeFinding({
        category: "untouched_consumer",
        title: `Suspiciously untouched: ${item.file}`,
        summary: item.reason,
        provenance: "inference",
        evidence: item.evidence,
        extra: { referencesChangedSymbol: true },
      })
    );
  }

  return findings;
}
