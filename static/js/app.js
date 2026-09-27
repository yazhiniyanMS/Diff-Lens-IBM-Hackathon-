import * as git from "./browserGit.js";
import { loadFromDirectoryHandle, loadFromFileList, loadFromZip, loadFromGithubUrl } from "./browserFs.js";
import { runAnalysis } from "./browserReviewBrief.js";
import { validatePatch, applyPatch, PatchValidationError } from "./browserPatch.js";
import { renderEvidenceDocs } from "./lib/evidence.js";
import { loadAISettings, saveAISettings, createBrowserProvider } from "./lib/aiProvider/browserProviderFactory.js";

const $ = (sel) => document.querySelector(sel);

// Never filter out .git -- DiffLens needs it. Everything else here is
// generated/dependency output that (a) DiffLens's own analysis already
// ignores and (b) is the single biggest reason a folder upload fails: a
// real project's node_modules alone can be tens of thousands of files.
const UPLOAD_IGNORE_RE = /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|\.cache|venv|\.venv|__pycache__|target|vendor)(\/|$)/i;

const state = {
  repo: null, // { fs, dir, name, dirHandle, writable }
  base: null,
  head: null,
  session: null,
  aiProvider: null,
};

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("error", "ok");
  if (kind) el.classList.add(kind);
}

// --- AI provider settings ----------------------------------------------------

function refreshAiSettingsFields() {
  const kind = $("#aiKind").value;
  $("#aiBaseUrlField").style.display = kind === "mock" ? "none" : "block";
  $("#aiKeyField").style.display = kind === "mock" ? "none" : "block";
  $("#aiModelField").style.display = kind === "mock" ? "none" : "block";
}

function loadAiSettingsIntoUI() {
  const settings = loadAISettings();
  $("#aiKind").value = settings.kind || "mock";
  $("#aiBaseUrl").value = settings.baseUrl || "";
  $("#aiApiKey").value = settings.apiKey || "";
  $("#aiModel").value = settings.model || "";
  refreshAiSettingsFields();
  applyAiProvider(settings);
}

function applyAiProvider(settings) {
  try {
    state.aiProvider = createBrowserProvider(settings);
    $("#providerPill").textContent = `provider: ${state.aiProvider.name}`;
  } catch (err) {
    $("#providerPill").textContent = "provider: (invalid settings)";
  }
}

$("#aiKind").addEventListener("change", refreshAiSettingsFields);
$("#saveAiSettingsBtn").addEventListener("click", () => {
  const settings = {
    kind: $("#aiKind").value,
    baseUrl: $("#aiBaseUrl").value.trim(),
    apiKey: $("#aiApiKey").value,
    model: $("#aiModel").value.trim(),
  };
  saveAISettings(settings);
  applyAiProvider(settings);
  setStatus($("#aiSettingsStatus"), "Saved.", "ok");
});

// --- Repo loading -------------------------------------------------------------

async function onRepoLoaded(repo) {
  const statusEl = $("#repoStatus");
  if (!repo.valid) {
    setStatus(statusEl, "Not a git repository (no .git found in what was loaded).", "error");
    return;
  }
  state.repo = repo;
  const [branches, currentRef] = await Promise.all([git.listBranches(repo.fs, repo.dir), git.getCurrentRef(repo.fs, repo.dir)]);
  state.repo.branches = branches;
  state.repo.currentRef = currentRef;

  setStatus(statusEl, `${repo.name} · on ${currentRef}`, "ok");
  $("#writabilityNote").textContent = repo.writable
    ? "Fixes you approve are written straight to these files."
    : "Read-only copy — approved fixes are offered as downloads.";

  populateRefSelects(branches, currentRef);
  $("#compareSection").style.display = "block";
  $("#analyzeSection").style.display = "none";
  $("#diffPanel").classList.add("hidden");
  $("#summaryPanel").classList.add("hidden");
  $("#summarySection").classList.add("hidden");
}

$("#chooseFolderBtn").addEventListener("click", async () => {
  const statusEl = $("#repoStatus");
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker();
      setStatus(statusEl, `Reading ${handle.name}…`);
      const repo = await loadFromDirectoryHandle(handle);
      await onRepoLoaded(repo);
    } catch (err) {
      if (err.name !== "AbortError") setStatus(statusEl, err.message, "error");
    }
    return;
  }
  // Firefox/Safari: no File System Access API -- fall back to the classic
  // <input webkitdirectory> picker (read-only; Fix Mode offers a download).
  $("#folderInput").click();
});

$("#chooseZipBtn").addEventListener("click", () => $("#zipInput").click());

$("#folderInput").addEventListener("change", async (e) => {
  const allFiles = Array.from(e.target.files || []);
  const statusEl = $("#repoStatus");
  if (!allFiles.length) return;

  const files = allFiles.filter((f) => !UPLOAD_IGNORE_RE.test(f.webkitRelativePath || f.name));
  const skipped = allFiles.length - files.length;
  if (!files.length) {
    return setStatus(statusEl, "Nothing to load after skipping node_modules/build/etc. Is this the right folder?", "error");
  }
  setStatus(statusEl, `Reading ${files.length} file(s)${skipped ? ` (skipped ${skipped} in node_modules/build/dist/etc.)` : ""}…`);
  try {
    const fileListLike = files; // plain array works fine with Array.from() in loadFromFileList
    const repo = await loadFromFileList(fileListLike);
    await onRepoLoaded(repo);
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  } finally {
    e.target.value = "";
  }
});

$("#zipInput").addEventListener("change", async (e) => {
  const file = (e.target.files || [])[0];
  const statusEl = $("#repoStatus");
  if (!file) return;
  setStatus(statusEl, `Reading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const repo = await loadFromZip(buf, file.name);
    await onRepoLoaded(repo);
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  } finally {
    e.target.value = "";
  }
});

$("#loadGithubBtn").addEventListener("click", async () => {
  const url = $("#githubUrl").value.trim();
  const statusEl = $("#repoStatus");
  if (!url) return setStatus(statusEl, "Enter a GitHub repository URL.", "error");
  setStatus(statusEl, "Cloning in-browser via a CORS proxy (public repos only, this can take a moment)…");
  try {
    const repo = await loadFromGithubUrl(url);
    await onRepoLoaded(repo);
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});
$("#githubUrl").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#loadGithubBtn").click();
});

function populateRefSelects(branches, currentRef) {
  const baseSel = $("#baseRef");
  const headSel = $("#headRef");
  baseSel.innerHTML = "";
  headSel.innerHTML = "";
  const refOptions = [git.REF.WORKING_TREE, git.REF.STAGED, ...branches];
  for (const ref of refOptions) {
    baseSel.appendChild(new Option(refLabel(ref), ref));
    headSel.appendChild(new Option(refLabel(ref), ref));
  }
  const mainLike = branches.find((b) => b === "main" || b === "master") || branches[0];
  const base = mainLike || git.REF.WORKING_TREE;
  baseSel.value = base;

  const candidates = [];
  if (currentRef && branches.includes(currentRef) && currentRef !== base) candidates.push(currentRef);
  const otherBranch = branches.find((b) => b !== base);
  if (otherBranch) candidates.push(otherBranch);
  candidates.push(git.REF.WORKING_TREE, git.REF.STAGED);

  headSel.value = candidates[0];
  updateHeadHint(base, headSel.value);
  headSel.onchange = () => updateHeadHint(baseSel.value, headSel.value);
  baseSel.onchange = () => updateHeadHint(baseSel.value, headSel.value);
}

function updateHeadHint(base, head) {
  const statusEl = $("#diffStatus");
  if (base === head) {
    setStatus(statusEl, "Base and head are the same ref — pick a different head to see a diff.", "error");
  } else {
    setStatus(statusEl, "");
  }
}

function refLabel(ref) {
  if (ref === git.REF.WORKING_TREE) return "Working tree (uncommitted changes)";
  if (ref === git.REF.STAGED) return "Staged changes";
  return ref;
}

// --- Diff inspection -----------------------------------------------------------

$("#loadDiffBtn").addEventListener("click", async () => {
  const base = $("#baseRef").value;
  const head = $("#headRef").value;
  const statusEl = $("#diffStatus");
  setStatus(statusEl, "Computing diff…");
  try {
    const diffText = await git.getDiff(state.repo.fs, state.repo.dir, base, head);
    state.base = base;
    state.head = head;
    renderDiff(diffText);
    $("#diffPanel").classList.remove("hidden");
    $("#analyzeSection").style.display = "block";
    if (!diffText.trim()) {
      setStatus(statusEl, "No differences between these two refs.", "error");
    } else {
      setStatus(statusEl, "Diff ready — this is all a line-by-line review sees.", "ok");
      if ($("#emptyState").style.display !== "none") {
        $("#emptyTitle").textContent = "Diff Ready";
        $("#emptyText").textContent = "Analyze Change to see which tests, docs, and consumers this change reaches beyond the lines shown above.";
      }
    }
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

function renderDiff(diffText) {
  const container = $("#diffView");
  container.innerHTML = "";
  if (!diffText.trim()) {
    container.innerHTML = '<div class="diff-line diff-context">(empty diff)</div>';
    return;
  }
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git")) {
      const div = document.createElement("div");
      div.className = "diff-file-header";
      div.textContent = line.replace("diff --git ", "");
      container.appendChild(div);
    } else if (line.startsWith("@@")) {
      const div = document.createElement("div");
      div.className = "diff-line diff-hunk-header";
      div.textContent = line;
      container.appendChild(div);
    } else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
      continue;
    } else {
      const div = document.createElement("div");
      div.className = "diff-line " + (line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-context");
      div.textContent = line || " ";
      container.appendChild(div);
    }
  }
}

// --- Analyze ---------------------------------------------------------------

$("#analyzeBtn").addEventListener("click", async () => {
  const btn = $("#analyzeBtn");
  const statusEl = $("#analyzeStatus");
  btn.disabled = true;
  setStatus(statusEl, "Analyzing — tracing symbols across the repository…");
  $("#summaryPanel").classList.add("hidden");
  try {
    const session = await runAnalysis({
      fs: state.repo.fs,
      dir: state.repo.dir,
      repoName: state.repo.name,
      base: state.base,
      head: state.head,
      provider: state.aiProvider,
    });
    state.session = session;
    renderSession(session);
    if (session.empty) {
      setStatus(statusEl, "No changes to analyze — base and head are identical. Pick a different head above.", "error");
    } else {
      setStatus(statusEl, "Analysis complete.", "ok");
      $("#summarySection").classList.remove("hidden");
    }
  } catch (err) {
    setStatus(statusEl, err.message, "error");
    console.error(err);
  } finally {
    btn.disabled = false;
  }
});

function renderSession(session) {
  $("#emptyState").style.display = "none";
  if (session.empty) {
    $("#radarPanel").style.display = "none";
    $("#briefPanel").style.display = "none";
    $("#emptyState").style.display = "block";
    $("#emptyTitle").textContent = "Nothing to Analyze";
    $("#emptyText").textContent = "The base and compare refs are identical. Choose a different branch to compare.";
    return;
  }
  $("#radarPanel").style.display = "block";
  $("#briefPanel").style.display = "block";
  renderRadarSection(session);
  renderBrief(session);
}

function renderRadarSection(session) {
  const wrap = $("#radarSvgWrap");
  window.DiffLensRadar.renderRadar(wrap, session.radar, (target) => showNodeModal(session, target));
  const legend = $("#radarLegend");
  const glyph = window.DiffLensRadar.STATUS_GLYPH;
  legend.innerHTML = `
    <div class="legend-item"><span class="dot changed"></span> Changed file (${glyph.changed})</div>
    <div class="legend-item"><span class="dot affected"></span> Affected (${glyph.affected})</div>
    <div class="legend-item"><span class="dot potentially_affected"></span> Potentially affected (${glyph.potentially_affected})</div>
    <div class="legend-item"><span class="dot risk"></span> Needs attention (${glyph.risk})</div>
    <div class="legend-item"><span class="dot verified"></span> Verified (${glyph.verified})</div>
    <p style="color:var(--text-2);margin-top:6px">Click any node for the evidence behind it.</p>
  `;
}

function showNodeModal(session, target) {
  if (target.kind === "changed") {
    openModal(`Changed file`, `<p class="mono">${escapeHtml(target.file)}</p><p style="color:var(--text-2)">This file was directly modified in the diff being reviewed.</p>`);
    return;
  }
  const node = target.node;
  const related = session.findings.filter((f) => node.findingIds.includes(f.id));
  const matchesHtml = (node.matches || [])
    .map((m) => `<li><code>${escapeHtml(m.term)}</code> — ${escapeHtml(m.kind)} (${m.count}×, line ${m.lines.join(", ")})</li>`)
    .join("");
  const findingsHtml = related.length
    ? related.map((f) => findingCardHtml(f)).join("")
    : `<p style="color:var(--text-2)">No finding directly attached, but repository evidence links this file to the change:</p>`;
  openModal(
    `Why is ${escapeHtml(node.file)} relevant?`,
    `<p><span class="badge risk-${node.status === "risk" ? "high" : node.status === "potentially_affected" ? "medium" : "low"}">${escapeHtml(node.relationshipType)}</span></p>
     <h4 style="margin-bottom:4px">Matched evidence</h4>
     <ul class="evidence-list">${matchesHtml || "<li>(none)</li>"}</ul>
     <h4 style="margin-bottom:4px">Related findings</h4>
     ${findingsHtml}`
  );
}

// --- Review Brief ------------------------------------------------------------

const SECTIONS = [
  { id: "intent", title: "PR Intent", render: renderIntentSection },
  { id: "whatChanged", title: "What Changed", render: renderWhatChangedSection },
  { id: "behavioral_change", title: "Behavioral Impact", categories: ["behavioral_change"] },
  { id: "workflows", title: "Affected User Journeys", render: renderWorkflowsSection },
  { id: "blastRadius", title: "Blast Radius", render: renderBlastRadiusSection },
  { id: "api_contract_change", title: "API & Contract Changes", categories: ["api_contract_change"] },
  { id: "schema", title: "Schema & Interface Impact", render: renderSchemaSection },
  { id: "missing_test", title: "Testing Gaps", categories: ["missing_test"] },
  { id: "documentation_gap", title: "Documentation Gaps", categories: ["documentation_gap"] },
  { id: "security_concern", title: "Security & Validation Concerns", categories: ["security_concern"] },
  { id: "backward_compatibility", title: "Backward Compatibility", categories: ["backward_compatibility"] },
  { id: "untouched_consumer", title: "Surprisingly Untouched Files", categories: ["untouched_consumer"] },
  { id: "questions", title: "Reviewer Questions", render: renderQuestionsSection },
];

function renderBrief(session) {
  const root = $("#briefRoot");
  root.innerHTML = "";
  SECTIONS.forEach((section, idx) => {
    const findings = section.categories ? session.findings.filter((f) => section.categories.includes(f.category)) : null;
    const count = findings ? findings.length : null;

    const wrapper = document.createElement("div");
    wrapper.className = "brief-section" + (idx < 2 ? " open" : "");
    wrapper.id = `section-${section.id}`;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "brief-section-head";
    head.setAttribute("aria-expanded", idx < 2 ? "true" : "false");
    head.innerHTML = `<h3>${section.title}</h3><span>${count !== null ? `<span class="brief-section-count">${count}</span>` : ""} <span class="chevron">▸</span></span>`;
    head.addEventListener("click", () => {
      const open = wrapper.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
    });

    const body = document.createElement("div");
    body.className = "brief-section-body";

    if (section.render) {
      body.innerHTML = section.render(session);
    } else {
      body.innerHTML = findings.length ? findings.map((f) => findingCardHtml(f)).join("") : `<p style="color:var(--text-2)">No findings in this category.</p>`;
    }

    wrapper.appendChild(head);
    wrapper.appendChild(body);
    root.appendChild(wrapper);
  });

  attachFindingHandlers(session);
}

function renderIntentSection(session) {
  const a = session.analysis;
  if (!a) return "<p>No analysis.</p>";
  return `<p>${escapeHtml(a.intent)} <span class="badge provenance">${a.intentProvenance}</span></p>`;
}

function renderWhatChangedSection(session) {
  const s = session.diffSummary;
  return `<p>${s.filesChanged} file(s) changed · +${s.additions} / -${s.deletions}</p>
    <ul class="evidence-list">
      ${s.modified.map((f) => `<li>modified <code>${escapeHtml(f)}</code></li>`).join("")}
      ${s.added.map((f) => `<li>added <code>${escapeHtml(f)}</code></li>`).join("")}
      ${s.deleted.map((f) => `<li>deleted <code>${escapeHtml(f)}</code></li>`).join("")}
      ${s.renamed.map((f) => `<li>renamed <code>${escapeHtml(f)}</code></li>`).join("")}
    </ul>`;
}

function renderWorkflowsSection(session) {
  const a = session.analysis;
  if (!a || !a.affectedWorkflows.length) return `<p style="color:var(--text-2)">No specific user journeys identified.</p>`;
  return `<ul class="evidence-list">${a.affectedWorkflows.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
}

function renderBlastRadiusSection(session) {
  const radar = session.radar;
  const byRing = {};
  for (const n of radar.nodes) {
    byRing[n.ring] = byRing[n.ring] || [];
    byRing[n.ring].push(n);
  }
  const rows = Object.entries(byRing)
    .map(([ring, nodes]) => `<li><strong>${escapeHtml(ring)}</strong> (${nodes.length}): ${nodes.map((n) => escapeHtml(n.file)).join(", ")}</li>`)
    .join("");
  return `<p>${radar.center.length} changed file(s) → ${radar.nodes.length} related node(s) discovered across ${radar.rings.length} categories.</p>
    <ul class="evidence-list">${rows || "<li>No related nodes found.</li>"}</ul>`;
}

function renderSchemaSection(session) {
  const items = session.analysis?.schemaInterfaceImpact || [];
  if (!items.length) return `<p style="color:var(--text-2)">No schema/interface-level findings for this change.</p>`;
  return items.map((i) => `<p><span class="badge provenance">${i.provenance}</span> ${escapeHtml(i.summary)}</p>`).join("");
}

function renderQuestionsSection(session) {
  const qs = session.analysis?.reviewQuestions || [];
  return `<ol class="evidence-list">${qs.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ol>`;
}

function findingCardHtml(f) {
  return `
    <div class="finding risk-${f.risk} status-${f.status}" data-finding-id="${f.id}">
      <div class="finding-top">
        <div class="finding-title">${escapeHtml(f.title)}</div>
        <div>
          <span class="badge risk-${f.risk}">${f.risk}</span>
          <span class="badge provenance">${f.provenance}</span>
        </div>
      </div>
      <div class="finding-summary">${escapeHtml(f.summary)}</div>
      <div class="finding-rationale">Risk rule (${escapeHtml(f.riskRuleId)}): ${escapeHtml(f.riskRationale)}</div>
      ${
        f.evidence && f.evidence.length
          ? `<ul class="evidence-list">${f.evidence
              .map((e) => `<li><code>${escapeHtml(e.file || "")}</code>${e.lines?.length ? ` (lines ${e.lines.join(", ")})` : ""}${e.note ? ` — ${escapeHtml(e.note)}` : ""}</li>`)
              .join("")}</ul>`
          : ""
      }
      <div class="finding-actions">
        <span class="finding-status-pill">${STATUS_LABEL[f.status] || f.status}</span>
        <button class="small" data-action="accept">Accept</button>
        <button class="small" data-action="dismiss">Dismiss</button>
        <button class="small" data-action="needs_review">Needs Review</button>
        ${f.actionable ? `<button class="small primary" data-action="fix">Suggest Fix…</button>` : ""}
      </div>
    </div>`;
}

function attachFindingHandlers(session) {
  document.querySelectorAll(".finding").forEach((card) => {
    const findingId = card.dataset.findingId;
    card.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "fix") return openFixModal(session, findingId);
        const statusMap = { accept: "accepted", dismiss: "dismissed", needs_review: "needs_review" };
        const idx = session.findings.findIndex((f) => f.id === findingId);
        session.findings[idx] = { ...session.findings[idx], status: statusMap[action] };
        renderBrief(session);
        refreshSummaryIfShown();
        const wrap = $("#radarSvgWrap");
        window.DiffLensRadar.renderRadar(wrap, session.radar, (t) => showNodeModal(session, t));
      });
    });
  });
}

// --- Fix Mode ----------------------------------------------------------------

async function openFixModal(session, findingId) {
  const finding = session.findings.find((f) => f.id === findingId);
  openModal("Generating patch…", `<p style="color:var(--text-2)">Asking ${escapeHtml(session.provider)} for a fix for "${escapeHtml(finding.title)}"…</p>`);
  try {
    const patch = await state.aiProvider.generatePatch(finding, {
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
      await validatePatch({ fs: state.repo.fs, dir: state.repo.dir, patch, snapshotHashes: session.fileSnapshots });
    } catch (err) {
      if (err instanceof PatchValidationError) validation = { valid: false, reason: err.message };
      else throw err;
    }
    const record = { id: `${finding.id}-${Date.now()}`, findingId: finding.id, patch, validation };
    session.patches.push(record);
    renderFixModal(session, record);
  } catch (err) {
    openModal("Could not generate patch", `<p class="status-line error">${escapeHtml(err.message)}</p>`);
  }
}

function renderFixModal(session, record) {
  const valid = record.validation?.valid !== false;
  openModal(
    "Suggested Fix — review before applying",
    `<p>${escapeHtml(record.patch.summary)}</p>
     <p style="color:var(--text-2);font-size:12.5px">${escapeHtml(record.patch.rationale)}</p>
     <pre class="patch-diff">${escapeHtml(record.patch.unifiedDiff || "(no textual diff)")}</pre>
     ${valid ? "" : `<p class="status-line error">Cannot apply: ${escapeHtml(record.validation.reason)}</p>`}
     <div class="finding-actions">
       <button class="primary" id="approveFixBtn" ${valid ? "" : "disabled"}>Approve &amp; Apply</button>
       <button id="rejectFixBtn">Reject</button>
     </div>
     <div id="fixApplyStatus" class="status-line"></div>`
  );
  $("#rejectFixBtn").addEventListener("click", closeModal);
  if (valid) {
    $("#approveFixBtn").addEventListener("click", async () => {
      const statusEl = $("#fixApplyStatus");
      setStatus(statusEl, "Applying…");
      try {
        const applied = await applyPatch({
          fs: state.repo.fs,
          dir: state.repo.dir,
          patch: record.patch,
          snapshotHashes: session.fileSnapshots,
          dirHandle: state.repo.dirHandle,
        });
        const diskNote = state.repo.dirHandle ? (applied.wroteToDisk ? " (written to your real files)" : " (could not write to disk — check folder permissions)") : " (in-browser copy only — use Download to save it)";
        setStatus(statusEl, `Applied. Touched: ${applied.touchedFiles.join(", ") || "(no changes needed)"}${diskNote}`, "ok");
        const idx = session.findings.findIndex((f) => f.id === record.findingId);
        if (idx !== -1) session.findings[idx].status = "fixed";
        if (!state.repo.dirHandle) {
          addDownloadButtonsForTouchedFiles(statusEl.parentElement, applied.details);
        }
        renderBrief(session);
        refreshSummaryIfShown();
      } catch (err) {
        setStatus(statusEl, err.message, "error");
      }
    });
  }
}

function addDownloadButtonsForTouchedFiles(container, details) {
  for (const [relPath, info] of Object.entries(details)) {
    const btn = document.createElement("button");
    btn.className = "small";
    btn.style.marginTop = "6px";
    btn.textContent = `Download ${relPath.split("/").pop()}`;
    btn.addEventListener("click", () => downloadTextFile(relPath.split("/").pop(), info.content));
    container.appendChild(btn);
  }
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Reviewer summary / evidence docs -----------------------------------------

const RISK_ORDER = ["high", "medium", "low", "informational"];
const RISK_LABEL = { high: "High", medium: "Medium", low: "Low", informational: "Info" };
const RISK_GLYPH = { high: "▲", medium: "◆", low: "●", informational: "○" };
const STATUS_LABEL = { needs_review: "Needs review", accepted: "Accepted", dismissed: "Dismissed", fixed: "Fixed" };

function byRisk(a, b) {
  return RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk);
}

function buildSummaryModel(session) {
  const findings = [...session.findings].sort(byRisk);
  const open = findings.filter((f) => f.status === "needs_review" || f.status === "accepted");
  const fixed = findings.filter((f) => f.status === "fixed");
  const dismissed = findings.filter((f) => f.status === "dismissed");
  const counts = Object.fromEntries(RISK_ORDER.map((r) => [r, findings.filter((f) => f.risk === r && f.status !== "dismissed").length]));
  const openHigh = open.filter((f) => f.risk === "high").length;
  const openMedium = open.filter((f) => f.risk === "medium").length;

  let verdict;
  if (openHigh) {
    verdict = { tone: "block", symbol: "!", title: "Not Ready to Merge", sub: `${openHigh} high-risk ${openHigh === 1 ? "finding needs" : "findings need"} to be resolved first.` };
  } else if (openMedium) {
    verdict = { tone: "caution", symbol: "!", title: "Merge With Caution", sub: `No high-risk findings remain, but ${openMedium} medium-risk ${openMedium === 1 ? "one is" : "ones are"} still open.` };
  } else {
    verdict = { tone: "clear", symbol: "✓", title: "Ready to Merge", sub: open.length ? "Only low-risk notes remain." : "Every finding has been fixed or dismissed." };
  }

  const s = session.diffSummary;
  return {
    repo: session.evidencePackage?.repoMeta?.name || state.repo?.name || "Repository",
    base: session.base,
    head: session.head,
    provider: session.provider,
    intent: session.analysis?.intent,
    intentProvenance: session.analysis?.intentProvenance,
    questions: session.analysis?.reviewQuestions || [],
    stats: { files: s.filesChanged, additions: s.additions, deletions: s.deletions, related: session.radar?.nodes?.length || 0, findings: findings.length - dismissed.length },
    counts, open, fixed, dismissed, verdict,
  };
}

function summaryRowHtml(f) {
  const files = [...new Set((f.evidence || []).map((e) => e.file).filter(Boolean))].slice(0, 4);
  return `<li class="summary-row">
      <span class="badge risk-${f.risk}">${RISK_LABEL[f.risk]}</span>
      <div>
        <div class="row-title">${escapeHtml(f.title)}</div>
        <div class="row-sub">${escapeHtml(f.summary)}</div>
        ${files.length ? `<div class="row-files">${files.map((x) => `<code>${escapeHtml(x)}</code>`).join("")}</div>` : ""}
      </div>
      <span class="status-chip ${f.status}">${STATUS_LABEL[f.status]}</span>
    </li>`;
}

function renderSummary(session) {
  const m = buildSummaryModel(session);
  const total = RISK_ORDER.reduce((n, r) => n + m.counts[r], 0);
  const meterLabel = RISK_ORDER.filter((r) => m.counts[r]).map((r) => `${m.counts[r]} ${RISK_LABEL[r].toLowerCase()}`).join(", ") || "no findings";
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  $("#summaryPanel").innerHTML = `
    <header class="summary-head">
      <div>
        <p class="summary-eyebrow">Review Summary</p>
        <h2 class="summary-repo" id="summaryRepo">${escapeHtml(m.repo)}</h2>
        <div class="summary-meta">
          <span class="ref-chip">${escapeHtml(refLabel(m.base))}</span><span class="arrow" aria-label="compared with">→</span><span class="ref-chip">${escapeHtml(refLabel(m.head))}</span>
          <span class="sep" aria-hidden="true">·</span><span>${escapeHtml(time)}</span>
          <span class="sep" aria-hidden="true">·</span><span>${escapeHtml(m.provider)}</span>
        </div>
      </div>
      <div class="summary-actions">
        <button class="small" id="copySummaryBtn">Copy Markdown</button>
        <button class="small" id="downloadSummaryBtn">Download .md</button>
      </div>
    </header>

    <div class="verdict ${m.verdict.tone}" role="status">
      <span class="verdict-symbol" aria-hidden="true">${m.verdict.symbol}</span>
      <div>
        <div class="verdict-title">${m.verdict.title}</div>
        <div class="verdict-sub">${escapeHtml(m.verdict.sub)}</div>
      </div>
    </div>

    <div class="risk-meter-wrap">
      <div class="risk-meter" role="img" aria-label="Findings by risk: ${meterLabel}">
        ${RISK_ORDER.filter((r) => m.counts[r]).map((r) => `<span class="seg-${r}" style="flex:${m.counts[r]}"></span>`).join("")}
      </div>
      <ul class="risk-legend" aria-hidden="true">
        ${RISK_ORDER.map((r) => `<li><span class="glyph-${r}">${RISK_GLYPH[r]}</span>${RISK_LABEL[r]} <strong>${m.counts[r]}</strong></li>`).join("")}
      </ul>
    </div>

    <dl class="stat-grid">
      <div class="stat"><dt>Files Changed</dt><dd>${m.stats.files}</dd></div>
      <div class="stat"><dt>Lines</dt><dd><span class="add">+${m.stats.additions}</span> <span class="del">−${m.stats.deletions}</span></dd></div>
      <div class="stat"><dt>Related Files</dt><dd>${m.stats.related}</dd></div>
      <div class="stat"><dt>Findings</dt><dd>${total}</dd></div>
    </dl>

    <div class="summary-body">
      ${m.intent ? `<section class="summary-section"><h3>What This Change Does</h3>
        <p class="summary-intent">${escapeHtml(m.intent)}${m.intentProvenance ? `<span class="badge provenance">${escapeHtml(m.intentProvenance)}</span>` : ""}</p></section>` : ""}

      <section class="summary-section"><h3>Needs Attention <span class="count">${m.open.length}</span></h3>
        ${m.open.length ? `<ul class="summary-list">${m.open.map(summaryRowHtml).join("")}</ul>` : `<p class="summary-empty">Nothing left open.</p>`}
      </section>

      ${m.fixed.length ? `<section class="summary-section"><h3>Fixed <span class="count">${m.fixed.length}</span></h3>
        <ul class="summary-list">${m.fixed.map(summaryRowHtml).join("")}</ul></section>` : ""}

      ${m.questions.length ? `<section class="summary-section"><h3>Questions for the Author</h3>
        <ol class="summary-questions">${m.questions.map((q) => `<li><span>${escapeHtml(q)}</span></li>`).join("")}</ol></section>` : ""}

      ${m.dismissed.length ? `<section class="summary-section"><details class="summary-dismissed"><summary>${m.dismissed.length} dismissed ${m.dismissed.length === 1 ? "finding" : "findings"}</summary>
        <ul class="summary-list">${m.dismissed.map(summaryRowHtml).join("")}</ul></details></section>` : ""}

      <p class="summary-foot">The verdict comes from DiffLens's risk rules and your Accept / Dismiss choices in the Review Brief — it updates as you triage. Use it as a starting point, not a substitute for judgment.</p>
    </div>`;

  $("#copySummaryBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(summaryMarkdown(m));
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy Failed";
    }
    setTimeout(() => { btn.textContent = "Copy Markdown"; }, 1600);
  });
  $("#downloadSummaryBtn").addEventListener("click", () => {
    downloadTextFile(`${m.repo}-review-summary.md`, summaryMarkdown(m));
  });
}

function summaryMarkdown(m) {
  const row = (f) => [`- **${RISK_GLYPH[f.risk]} ${RISK_LABEL[f.risk]} · ${f.title}** _(${STATUS_LABEL[f.status]})_`, `  ${f.summary}`];
  const lines = [
    `# Review Summary — ${m.repo}`,
    `\`${refLabel(m.base)}\` → \`${refLabel(m.head)}\``,
    "",
    `## ${m.verdict.title}`,
    m.verdict.sub,
    "",
    `| Files changed | Lines | Related files | Findings |`,
    `| --- | --- | --- | --- |`,
    `| ${m.stats.files} | +${m.stats.additions} / −${m.stats.deletions} | ${m.stats.related} | ${m.stats.findings} |`,
    "",
  ];
  if (m.intent) lines.push("## What This Change Does", m.intent, "");
  lines.push(`## Needs Attention (${m.open.length})`);
  if (m.open.length) m.open.forEach((f) => lines.push(...row(f)));
  else lines.push("Nothing left open.");
  lines.push("");
  if (m.fixed.length) {
    lines.push(`## Fixed (${m.fixed.length})`);
    m.fixed.forEach((f) => lines.push(...row(f)));
    lines.push("");
  }
  if (m.questions.length) {
    lines.push("## Questions for the Author");
    m.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push("");
  }
  lines.push("_Generated by DiffLens._");
  return lines.join("\n");
}

function refreshSummaryIfShown() {
  if (state.session && !$("#summaryPanel").classList.contains("hidden")) renderSummary(state.session);
}

$("#genSummaryBtn").addEventListener("click", () => {
  if (!state.session) return;
  renderSummary(state.session);
  const panel = $("#summaryPanel");
  panel.classList.remove("hidden");
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
});

$("#genEvidenceBtn").addEventListener("click", async () => {
  if (!state.session) return;
  const statusEl = $("#evidenceStatus");
  setStatus(statusEl, "Building evidence docs…");
  try {
    const docs = renderEvidenceDocs(state.session);
    const fflate = await import("../vendor/fflate.js");
    const files = {};
    for (const [name, content] of Object.entries(docs)) {
      files[`bob-code-review/${name}`] = new TextEncoder().encode(content);
    }
    const zipped = fflate.zipSync(files);
    const blob = new Blob([zipped], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bob-code-review.zip";
    a.click();
    URL.revokeObjectURL(url);
    setStatus(statusEl, "Downloaded bob-code-review.zip", "ok");
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

// --- Modal ---------------------------------------------------------------------

let lastFocused = null;
function openModal(title, bodyHtml) {
  lastFocused = document.activeElement;
  const root = $("#modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <button class="modal-close small" id="modalCloseBtn" aria-label="Close dialog">✕</button>
        <h3 id="modalTitle">${escapeHtml(title)}</h3>
        <div id="modalBody">${bodyHtml}</div>
      </div>
    </div>`;
  $("#modalCloseBtn").addEventListener("click", closeModal);
  $("#modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") closeModal();
  });
  document.addEventListener("keydown", onModalKeydown);
  $("#modalCloseBtn").focus();
}

function onModalKeydown(e) {
  if (e.key === "Escape") closeModal();
}

function closeModal() {
  $("#modalRoot").innerHTML = "";
  document.removeEventListener("keydown", onModalKeydown);
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Init ------------------------------------------------------------------------

loadAiSettingsIntoUI();
