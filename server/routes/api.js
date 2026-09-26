import { Router } from "express";
import path from "node:path";
import * as git from "../lib/git.js";
import { runAnalysis } from "../lib/reviewBrief.js";
import { getStore } from "../lib/store.js";
import { getAIProvider } from "../lib/aiProvider/index.js";
import { validatePatch, PatchValidationError } from "../lib/patch/validator.js";
import { applyPatch } from "../lib/patch/apply.js";
import { runVerification } from "../lib/verify.js";
import { writeEvidenceDocs } from "../lib/evidenceWriter.js";

const router = Router();
const store = getStore();

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

router.get("/health", (req, res) => {
  res.json({ ok: true, provider: getAIProvider().name });
});

// --- Repository selection -------------------------------------------------

router.post(
  "/repos/validate",
  asyncRoute(async (req, res) => {
    const { repoPath } = req.body;
    if (!repoPath) return res.status(400).json({ error: "repoPath is required" });
    if (!git.isLikelyGitRepo(repoPath)) {
      return res.status(200).json({ valid: false, reason: "Not a git repository (no .git directory found)." });
    }
    await git.assertGitRepo(repoPath);
    const [name, branches, currentRef] = await Promise.all([
      git.getRepoName(repoPath),
      git.listBranches(repoPath),
      git.getCurrentRef(repoPath),
    ]);
    res.json({ valid: true, name, branches, currentRef, refOptions: [git.REF.WORKING_TREE, git.REF.STAGED, ...branches] });
  })
);

router.get(
  "/repos/diff",
  asyncRoute(async (req, res) => {
    const { repoPath, base, head } = req.query;
    if (!repoPath || !base || !head) return res.status(400).json({ error: "repoPath, base, head are required" });
    const diffText = await git.getDiff(repoPath, base, head === "WORKING" ? git.REF.WORKING_TREE : head === "STAGED" ? git.REF.STAGED : head);
    res.json({ diffText });
  })
);

// --- Analysis --------------------------------------------------------------

router.post(
  "/analyze",
  asyncRoute(async (req, res) => {
    const { repoPath, base, head } = req.body;
    if (!repoPath || !base || !head) return res.status(400).json({ error: "repoPath, base, head are required" });
    const resolvedHead = head === "WORKING" ? git.REF.WORKING_TREE : head === "STAGED" ? git.REF.STAGED : head;
    const session = await runAnalysis({ repoPath, base, head: resolvedHead });
    store.save(session);
    res.json(session);
  })
);

router.get("/sessions", (req, res) => {
  res.json(store.list());
});

router.get("/sessions/:id", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// --- Reviewer actions on findings ------------------------------------------

router.post("/sessions/:id/findings/:findingId/decision", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const { status } = req.body;
  const valid = ["needs_review", "accepted", "dismissed", "fixed"];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of ${valid.join(", ")}` });
  const finding = session.findings.find((f) => f.id === req.params.findingId);
  if (!finding) return res.status(404).json({ error: "Finding not found" });
  finding.status = status;
  store.save(session);
  res.json(finding);
});

// --- Fix Mode: patch preview / apply ----------------------------------------

router.post(
  "/sessions/:id/findings/:findingId/patch",
  asyncRoute(async (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const finding = session.findings.find((f) => f.id === req.params.findingId);
    if (!finding) return res.status(404).json({ error: "Finding not found" });
    if (!finding.actionable) {
      return res.status(400).json({ error: "This finding is not marked actionable for automated patch generation." });
    }

    const provider = getAIProvider();
    const patch = await provider.generatePatch(finding, {
      ...session.evidencePackage,
      changeSignals: {
        removedFields: new Set(session.evidencePackage.changeSignals.removedFields),
        addedFields: new Set(session.evidencePackage.changeSignals.addedFields),
        touchedSymbolNames: new Set(session.evidencePackage.changeSignals.touchedSymbolNames),
        touchedRoutes: session.evidencePackage.changeSignals.touchedRoutes,
      },
    });

    let validation = { valid: true };
    try {
      validatePatch({ repoPath: session.repoPath, patch, snapshotHashes: session.fileSnapshots });
    } catch (err) {
      if (err instanceof PatchValidationError) {
        validation = { valid: false, reason: err.message };
      } else {
        throw err;
      }
    }

    const patchId = `${finding.id}-${Date.now()}`;
    const record = { id: patchId, findingId: finding.id, patch, validation, applied: false, createdAt: new Date().toISOString() };
    session.patches.push(record);
    store.save(session);
    res.json(record);
  })
);

router.post(
  "/sessions/:id/patches/:patchId/apply",
  asyncRoute(async (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const record = session.patches.find((p) => p.id === req.params.patchId);
    if (!record) return res.status(404).json({ error: "Patch not found" });
    if (record.applied) return res.status(400).json({ error: "Patch already applied" });

    try {
      const result = applyPatch({ repoPath: session.repoPath, patch: record.patch, snapshotHashes: session.fileSnapshots });
      record.applied = true;
      record.appliedResult = result;
      const finding = session.findings.find((f) => f.id === record.findingId);
      if (finding) finding.status = "fixed";
      store.save(session);
      res.json(record);
    } catch (err) {
      if (err instanceof PatchValidationError) {
        record.validation = { valid: false, reason: err.message };
        store.save(session);
        return res.status(409).json({ error: err.message, patch: record });
      }
      throw err;
    }
  })
);

// --- Verification ------------------------------------------------------------

router.post(
  "/sessions/:id/verify",
  asyncRoute(async (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const result = await runVerification(session.repoPath);
    session.verifications.push(result);
    store.save(session);
    res.json(result);
  })
);

// --- Evidence trail ------------------------------------------------------------

router.post(
  "/sessions/:id/evidence",
  asyncRoute(async (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const outDir = path.join(session.repoPath, "docs", "bob-code-review");
    const written = writeEvidenceDocs(session, outDir);
    res.json({ outDir, written });
  })
);

// --- Reviewer summary ------------------------------------------------------------

router.get("/sessions/:id/summary", (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const accepted = session.findings.filter((f) => f.status === "accepted" || f.status === "fixed");
  const lines = [
    `# Review Summary — ${session.evidencePackage?.repoMeta?.name || session.repoPath}`,
    `Comparing \`${session.base}\` → \`${session.head}\``,
    "",
  ];
  if (session.analysis?.intent) {
    lines.push(`**Intent:** ${session.analysis.intent}`, "");
  }
  if (accepted.length === 0) {
    lines.push("_No findings have been accepted yet._");
  } else {
    for (const f of accepted) {
      lines.push(`- **[${f.risk.toUpperCase()}] ${f.title}** (${f.status})`, `  ${f.summary}`);
    }
  }
  res.json({ markdown: lines.join("\n"), findingCount: accepted.length });
});

export default router;
