import * as git from "./browserGit.js";
import { loadFromDirectoryHandle, loadFromFileList, loadFromZip, loadFromGithubUrl } from "./browserFs.js";
import { runAnalysis } from "./browserReviewBrief.js";
import { validatePatch, applyPatch, PatchValidationError } from "./browserPatch.js";
import { renderEvidenceDocs } from "./lib/evidence.js";
import { loadAISettings, saveAISettings, createBrowserProvider } from "./lib/aiProvider/browserProviderFactory.js";
import { icon, hydrateIcons } from "./icons.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Generated/dependency folders: DiffLens ignores them anyway, and a real
// project's node_modules alone can be tens of thousands of files.
const IGNORE_RE = /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|\.cache|venv|\.venv|__pycache__|target|vendor)(\/|$)/i;

const RISK_ORDER = ["high", "medium", "low", "informational"];
const RISK_LABEL = { high: "High", medium: "Medium", low: "Low", informational: "Info" };
const NODE_LABEL = { changed: "Changed", risk: "Needs attention", potentially_affected: "May be affected", affected: "Related", verified: "Verified" };
const FILE_STATUS = { modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed" };

export const state = {
  repo: null,
  base: null,
  head: null,
  session: null,
  provider: null,
  filterFile: null,
  selectedId: null,
  expanded: new Set(),
  undo: null,
  busy: false,
};

// --- Small utilities ------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Escapes, then renders `backticked` names as code chips.
function rich(str) {
  return escapeHtml(str).replace(/`([^`]+)`/g, '<code class="tok">$1</code>');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function emitStep(name) {
  document.dispatchEvent(new CustomEvent("difflens:step", { detail: name }));
}

function refLabel(ref) {
  if (ref === git.REF.WORKING_TREE) return "Uncommitted changes";
  if (ref === git.REF.STAGED) return "Staged changes";
  return ref;
}

function downloadFile(filename, content, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Feedback: toasts -----------------------------------------------------------------

export function toast(message, { actionLabel, onAction, tone = "neutral", duration = 6000 } = {}) {
  const region = $("#toastRegion");
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${tone === "error" ? icon("alert") : icon("check")}</span><span class="toast-text">${rich(message)}</span>`;
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      onAction();
      remove();
    });
    el.appendChild(btn);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.innerHTML = icon("close");
  close.addEventListener("click", () => remove());
  el.appendChild(close);

  const existing = $$(".toast", region);
  if (existing.length >= 2) existing[0].remove();
  region.appendChild(el);
  let timer = setTimeout(remove, duration);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => (timer = setTimeout(remove, 2500)));
  function remove() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), reduceMotion() ? 0 : 180);
  }
}

// --- Errors that say what to do next -------------------------------------------------------

function friendlyError(err, where) {
  const raw = String(err?.message || err || "");
  if (/not a git repo|no \.git/i.test(raw)) {
    return where === "zip"
      ? "This .zip doesn't contain a git repository. Make sure the export includes the hidden .git folder."
      : "This folder isn't a git repository. Choose the project's top-level folder — the one that contains the hidden .git folder.";
  }
  if (where === "zip") return "That file couldn't be opened as a .zip. Try exporting the repository again, including its .git folder.";
  if (where === "github") {
    if (!navigator.onLine) return "You're offline. Opening from GitHub needs a connection — folders and .zip files still work offline.";
    if (/404|not found/i.test(raw)) return "That repository wasn't found. Check the URL, and make sure the repository is public.";
    return "GitHub couldn't be reached. Check the URL and try again, or download the repository as a .zip and open that instead.";
  }
  if (where === "sample") return "The sample repository didn't load. Check your connection and try again.";
  if (where === "analyze") return "The review couldn't be completed for this comparison. Try choosing different branches.";
  if (where === "fix") return "This fix couldn't be prepared. The finding stays open so you can raise it with the author.";
  return "Something went wrong. Please try again.";
}

// --- Views ----------------------------------------------------------------------------

function showLanding() {
  closeMenus();
  $("#appView").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  document.body.dataset.view = "landing";
  window.scrollTo(0, 0);
}

function showApp() {
  $("#landing").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  document.body.dataset.view = "app";
}

export function showView(name) {
  showApp();
  for (const id of ["openView", "progressView", "resultsView"]) {
    $(`#${id}`).classList.toggle("hidden", id !== `${name}View`);
  }
  document.body.dataset.stage = name;
  window.scrollTo(0, 0);
}

function setOpenStatus(text, tone) {
  const el = $("#openStatus");
  el.innerHTML = text ? `${tone === "error" ? icon("alert") : ""}<span>${escapeHtml(text)}</span>` : "";
  el.className = `open-status ${tone || ""}`;
}

function setStage(stage) {
  const order = ["read", "compare", "trace"];
  const idx = order.indexOf(stage);
  $$("#stages li").forEach((li, i) => {
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx);
    if (i === idx) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
}

// --- Opening a repository ---------------------------------------------------------------

async function openRepo(loader, where) {
  if (state.busy) return;
  state.busy = true;
  setOpenStatus("");
  showView("progress");
  setStage("read");
  try {
    const repo = await loader();
    if (!repo.valid) throw new Error("not a git repo");
    state.repo = repo;
    await reviewWithAutoComparison();
  } catch (err) {
    if (!/not a git repo/.test(err?.message)) console.error(err);
    showView("open");
    setOpenStatus(friendlyError(err, where), "error");
  } finally {
    state.busy = false;
  }
}

$("#chooseFolderBtn").addEventListener("click", async () => {
  if (window.showDirectoryPicker) {
    let handle;
    try {
      handle = await window.showDirectoryPicker();
    } catch (err) {
      if (err.name !== "AbortError") setOpenStatus(friendlyError(err, "repo"), "error");
      return;
    }
    return openRepo(() => loadFromDirectoryHandle(handle), "repo");
  }
  $("#folderInput").click();
});

$("#folderInput").addEventListener("change", (e) => {
  const files = [...(e.target.files || [])].filter((f) => !IGNORE_RE.test(f.webkitRelativePath || f.name));
  e.target.value = "";
  if (!files.length) return;
  openRepo(() => loadFromFileList(files), "repo");
});

$("#chooseZipBtn").addEventListener("click", () => $("#zipInput").click());
$("#zipInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) openRepo(async () => loadFromZip(await file.arrayBuffer(), file.name), "zip");
});

$("#sampleBtn").addEventListener("click", () => openSample());
export function openSample() {
  return openRepo(async () => {
    const res = await fetch("samples/demo-repo.zip");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return loadFromZip(await res.arrayBuffer(), "demo-repo.zip");
  }, "sample");
}

$("#githubForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#githubUrl").value.trim();
  if (!/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/i.test(url)) {
    setOpenStatus("Enter a repository URL like https://github.com/owner/repository.", "error");
    $("#githubUrl").focus();
    return;
  }
  openRepo(() => loadFromGithubUrl(url), "github");
});

// Drag and drop: a folder or a .zip, anywhere in the app.
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e) || state.busy) return;
  e.preventDefault();
  dragDepth++;
  $("#dropOverlay").classList.remove("hidden");
});
window.addEventListener("dragover", (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("#dropOverlay").classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#dropOverlay").classList.add("hidden");
  const item = [...e.dataTransfer.items].find((i) => i.kind === "file");
  if (!item) return;
  const entry = item.webkitGetAsEntry?.();
  const file = item.getAsFile();
  if (entry?.isDirectory) {
    openRepo(async () => loadFromFileList(await readDroppedFolder(entry)), "repo");
  } else if (file && /\.zip$/i.test(file.name)) {
    openRepo(async () => loadFromZip(await file.arrayBuffer(), file.name), "zip");
  } else {
    showView("open");
    setOpenStatus("DiffLens opens folders and .zip files. Drop a project folder, or a .zip of one.", "error");
  }
});

async function readDroppedFolder(rootEntry) {
  const out = [];
  async function walk(entry, path) {
    if (IGNORE_RE.test(path)) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ webkitRelativePath: path, name: file.name, arrayBuffer: () => file.arrayBuffer() });
      return;
    }
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walk(child, `${path}/${child.name}`);
    } while (batch.length);
  }
  await walk(rootEntry, rootEntry.name);
  return out;
}

// --- Choosing what to compare, automatically ----------------------------------------------

async function pickComparison(repo) {
  const branches = await git.listBranches(repo.fs, repo.dir);
  const current = await git.getCurrentRef(repo.fs, repo.dir).catch(() => null);
  repo.branches = branches;
  const base = branches.find((b) => b === "main" || b === "master") || current || branches[0];
  const others = branches.filter((b) => b !== base);
  if (current && current !== base && others.includes(current)) return { base, head: current };
  if (others.length) {
    const dated = await Promise.all(
      others.map(async (b) => {
        const meta = await git.commitMeta(repo.fs, repo.dir, b).catch(() => ({}));
        return { b, t: Date.parse(meta.date || "") || 0 };
      })
    );
    dated.sort((x, y) => y.t - x.t);
    return { base, head: dated[0].b };
  }
  return { base, head: git.REF.WORKING_TREE };
}

async function reviewWithAutoComparison() {
  setStage("compare");
  const { base, head } = await pickComparison(state.repo);
  await review(base, head);
}

async function review(base, head) {
  showView("progress");
  setStage("compare");
  state.base = base;
  state.head = head;
  let diffText;
  try {
    diffText = await git.getDiff(state.repo.fs, state.repo.dir, base, head);
  } catch (err) {
    console.error(err);
    renderReviewFailed(err);
    return;
  }
  if (!diffText.trim()) {
    state.session = null;
    renderNothingToReview();
    return;
  }
  setStage("trace");
  let session;
  try {
    session = await runAnalysis({ fs: state.repo.fs, dir: state.repo.dir, repoName: state.repo.name, base, head, provider: state.provider });
  } catch (err) {
    console.error(err);
    renderReviewFailed(err);
    return;
  }
  for (const f of session.findings) if (f.status === "accepted") f.status = "needs_review";
  state.session = session;
  state.filterFile = null;
  state.selectedId = null;
  state.expanded = new Set();
  state.undo = null;
  renderResults();
  emitStep("results");
}

// --- Results --------------------------------------------------------------------------

function verdictFor(session) {
  const open = session.findings.filter((f) => f.status === "needs_review");
  const high = open.filter((f) => f.risk === "high").length;
  const medium = open.filter((f) => f.risk === "medium").length;
  if (high) {
    return { tone: "block", mark: "!", title: "Not ready to merge", sub: `${plural(high, "high-risk finding needs", "high-risk findings need")} to be resolved first.` };
  }
  if (medium) {
    return { tone: "caution", mark: "!", title: "Merge with care", sub: `No high-risk findings remain. ${plural(medium, "medium-risk finding is", "medium-risk findings are")} still open.` };
  }
  return { tone: "clear", mark: "✓", title: "Ready to merge", sub: open.length ? "Only low-risk notes remain." : "Every finding has been fixed or dismissed." };
}

function findingFiles(f) {
  return [...new Set((f?.evidence || []).map((e) => e.file).filter(Boolean))];
}

function renderHead() {
  $("#repoTitle").textContent = state.repo?.name || "Repository";
  const refSpan = (r) => `<span class="${r === git.REF.WORKING_TREE || r === git.REF.STAGED ? "ref-plain" : "ref"}">${escapeHtml(refLabel(r))}</span>`;
  $("#compareLabel").innerHTML = `${refSpan(state.head)}<span class="into">into</span>${refSpan(state.base)}`;
  $("#compareBtn").setAttribute("aria-label", `Reviewing ${refLabel(state.head)} into ${refLabel(state.base)}. Change comparison`);
  $("#copyReviewBtn").disabled = !state.session;
}

function renderNothingToReview() {
  showView("results");
  renderHead();
  $("#resultsBody").innerHTML = `
    <div class="empty-block">
      ${icon("check-circle", "empty-icon")}
      <h2>Nothing to review</h2>
      <p>${escapeHtml(refLabel(state.head))} has no changes compared with ${escapeHtml(refLabel(state.base))}.</p>
      <button type="button" class="btn primary" data-open-compare>Choose What to Compare…</button>
    </div>`;
  $("[data-open-compare]").addEventListener("click", (e) => {
    e.stopPropagation();
    openComparePopover();
  });
}

function renderReviewFailed(err) {
  state.session = null;
  showView("results");
  renderHead();
  $("#resultsBody").innerHTML = `
    <div class="empty-block">
      ${icon("alert", "empty-icon warn")}
      <h2>This review couldn't finish</h2>
      <p>${escapeHtml(friendlyError(err, "analyze"))}</p>
      <button type="button" class="btn primary" data-open-compare>Choose What to Compare…</button>
      <details class="tech-details"><summary>Technical details</summary><pre>${escapeHtml(err?.message || String(err))}</pre></details>
    </div>`;
  $("[data-open-compare]").addEventListener("click", (e) => {
    e.stopPropagation();
    openComparePopover();
  });
}

function renderResults() {
  showView("results");
  renderHead();
  const s = state.session;
  $("#resultsBody").innerHTML = `
    <section class="verdict" id="verdict" aria-live="polite"></section>
    <dl class="stats" id="stats"></dl>
    <div class="results-grid">
      <div class="findings-col" id="findingsCol"></div>
      <aside class="context-col" aria-label="What the change touches">
        <section class="card map-card" id="mapSection" aria-labelledby="mapTitle">
          <div class="card-head">
            <h2 id="mapTitle">Blast radius</h2>
            <button type="button" class="link-btn hidden" id="clearFilterMap">Show all</button>
          </div>
          <p class="card-sub">Select a file to see only its findings.</p>
          <div id="radarWrap" class="radar-wrap"></div>
          <ul class="legend" aria-label="Legend">
            ${["changed", "risk", "potentially_affected", "affected"].map((k) => `<li><span class="legend-node ${k}" aria-hidden="true">${k === "affected" ? "" : window.DiffLensRadar.STATUS_GLYPH[k]}</span>${NODE_LABEL[k]}</li>`).join("")}
          </ul>
          <div class="affected" id="affectedList"></div>
        </section>
        <section class="card" aria-labelledby="intentTitle">
          <h2 id="intentTitle">What this change does</h2>
          <p class="intent">${rich(s.analysis?.intent || "No summary available.")}</p>
        </section>
        <section class="card" aria-labelledby="filesTitle">
          <h2 id="filesTitle">Changed files</h2>
          <ul class="file-list">${renderFileRows(s)}</ul>
        </section>
      </aside>
    </div>`;
  window.DiffLensRadar.renderRadar($("#radarWrap"), s.radar, onMapSelect);
  $("#clearFilterMap").addEventListener("click", () => setFilter(null));
  $$(".file-row-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      $(`#${btn.getAttribute("aria-controls")}`).hidden = !open;
    })
  );
  refreshReview();
}

function renderFileRows(s) {
  return (s.parsedFiles || [])
    .map((f, i) => {
      const path = f.status === "deleted" ? f.oldPath : f.newPath;
      const shown = f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : path;
      const lines = f.hunks
        .flatMap((h) => h.lines)
        .map(
          (l) =>
            `<div class="dl ${l.type}"><span class="ln">${l.type === "del" ? l.oldLineNo ?? "" : l.newLineNo ?? ""}</span><span class="sign" aria-hidden="true">${l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span><span class="code">${escapeHtml(l.content) || " "}</span></div>`
        )
        .join("");
      return `<li class="file-row">
          <button type="button" class="file-row-toggle" aria-expanded="false" aria-controls="diff-${i}">
            ${icon("chevron-right", "chev")}
            <code class="file-path" title="${escapeHtml(shown)}">${escapeHtml(shown)}</code>
            <span class="file-delta"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span>
          </button>
          <div class="file-diff" id="diff-${i}" hidden>
            <p class="file-meta">${FILE_STATUS[f.status] || f.status}</p>
            ${f.isBinary ? `<p class="muted">Binary file — no preview.</p>` : `<div class="diff-lines">${lines}</div>`}
          </div>
        </li>`;
    })
    .join("");
}

// Re-renders everything that depends on finding status or the file filter.
function refreshReview() {
  const s = state.session;
  if (!s) return;
  const v = verdictFor(s);
  const verdict = $("#verdict");
  verdict.className = `verdict ${v.tone}`;
  verdict.innerHTML = `<span class="verdict-mark ${v.tone}" aria-hidden="true">${v.mark}</span>
    <div><h2 class="verdict-title">${v.title}</h2><p class="verdict-sub">${escapeHtml(v.sub)}</p></div>`;

  const open = s.findings.filter((f) => f.status === "needs_review");
  const d = s.diffSummary;
  $("#stats").innerHTML = `
    <div><dt>Open findings</dt><dd>${open.length}</dd></div>
    <div><dt>Files changed</dt><dd>${d.filesChanged}</dd></div>
    <div><dt>Lines</dt><dd><span class="add">+${d.additions}</span> <span class="del">−${d.deletions}</span></dd></div>
    <div><dt>Files affected</dt><dd>${s.radar.nodes.length}</dd></div>`;

  renderFindings();
  renderAffected();
  syncMap();
}

const RING_ORDER = ["apis", "services", "schemas", "tests", "docs", "dependencies"];
const RING_TITLE = { apis: "APIs & consumers", services: "Services", schemas: "Schemas", tests: "Tests", docs: "Docs", dependencies: "Dependencies" };

function renderAffected() {
  const s = state.session;
  const open = s.findings.filter((f) => f.status === "needs_review");
  const countFor = (file) => open.filter((f) => findingFiles(f).includes(file)).length;
  const glyph = window.DiffLensRadar.STATUS_GLYPH;
  const groups = RING_ORDER.map((ring) => [ring, s.radar.nodes.filter((n) => n.ring === ring)]).filter(([, nodes]) => nodes.length);
  $("#affectedList").innerHTML = `<h3 class="affected-title">Affected files</h3>${groups
    .map(
      ([ring, nodes]) => `<p class="affected-ring">${RING_TITLE[ring] || ring}</p>
      <ul>${nodes
        .map((n) => {
          const c = countFor(n.file);
          const on = state.filterFile === n.file;
          return `<li><button type="button" class="affected-item ${on ? "selected" : ""}" data-affected="${escapeHtml(n.file)}" aria-pressed="${on}" title="${escapeHtml(n.file)}">
            <span class="legend-node ${n.status}" aria-hidden="true">${n.status === "affected" ? "" : glyph[n.status] || ""}</span>
            <span class="affected-name">${escapeHtml(n.file)}</span>
            ${c ? `<span class="count" aria-label="${plural(c, "open finding", "open findings")}">${c}</span>` : ""}
          </button></li>`;
        })
        .join("")}</ul>`
    )
    .join("")}`;
  $$("[data-affected]").forEach((b) => {
    const file = b.dataset.affected;
    b.addEventListener("click", () => setFilter(state.filterFile === file ? null : file));
    b.addEventListener("mouseenter", () => highlightFiles([file]));
    b.addEventListener("mouseleave", () => highlightFiles([]));
    b.addEventListener("focus", () => highlightFiles([file]));
    b.addEventListener("blur", () => highlightFiles([]));
  });
}

function byRisk(a, b) {
  return RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk);
}

function visibleOpenFindings() {
  return state.session.findings
    .filter((f) => f.status === "needs_review")
    .filter((f) => !state.filterFile || findingFiles(f).includes(state.filterFile))
    .sort(byRisk);
}

function renderFindings() {
  const s = state.session;
  const open = visibleOpenFindings();
  const fixed = s.findings.filter((f) => f.status === "fixed");
  const dismissed = s.findings.filter((f) => f.status === "dismissed").sort(byRisk);
  const questions = s.analysis?.reviewQuestions || [];
  const col = $("#findingsCol");
  const keepOpen = { fixed: $("#fixedGroup")?.open, dismissed: $("#dismissedGroup")?.open };
  const focusedId = document.activeElement?.closest?.(".finding")?.dataset.id;

  col.innerHTML = `
    <section class="card findings-card" aria-labelledby="findingsTitle">
      <div class="card-head">
        <h2 id="findingsTitle">Needs attention <span class="count">${open.length}</span></h2>
      </div>
      ${
        state.filterFile
          ? `<div class="filter-bar" role="status"><span>Showing findings for <code class="tok">${escapeHtml(state.filterFile)}</code></span>
             <button type="button" class="link-btn" id="clearFilter">Show all</button></div>`
          : ""
      }
      ${
        open.length
          ? `<ul class="finding-list" id="findingList">${open.map(findingRow).join("")}</ul>`
          : `<div class="list-empty">${icon("check-circle")}<p>${state.filterFile ? "No open findings for this file." : "Nothing needs attention. Copy the review to share it."}</p></div>`
      }
      ${
        fixed.length
          ? `<details class="group" id="fixedGroup" ${keepOpen.fixed ? "open" : ""}><summary>${icon("chevron-right", "chev")}Fixed <span class="count">${fixed.length}</span></summary>
             <ul class="finding-list compact">${fixed.map((f) => resolvedRow(f, "fixed")).join("")}</ul></details>`
          : ""
      }
      ${
        dismissed.length
          ? `<details class="group" id="dismissedGroup" ${keepOpen.dismissed ? "open" : ""}><summary>${icon("chevron-right", "chev")}Dismissed <span class="count">${dismissed.length}</span></summary>
             <ul class="finding-list compact">${dismissed.map((f) => resolvedRow(f, "dismissed")).join("")}</ul></details>`
          : ""
      }
    </section>
    ${
      questions.length
        ? `<section class="card" aria-labelledby="questionsTitle">
             <h2 id="questionsTitle">Questions for the author</h2>
             <ol class="question-list">${questions.map((q) => `<li><span>${rich(q)}</span></li>`).join("")}</ol>
           </section>`
        : ""
    }`;

  $("#clearFilter")?.addEventListener("click", () => setFilter(null));
  $$(".finding[data-id]", col).forEach((row) => {
    const id = row.dataset.id;
    $(".finding-toggle", row)?.addEventListener("click", () => toggleFinding(id));
    $("[data-act=dismiss]", row)?.addEventListener("click", () => setStatus(id, "dismissed"));
    $("[data-act=restore]", row)?.addEventListener("click", () => setStatus(id, "needs_review"));
    $("[data-act=fix]", row)?.addEventListener("click", () => openFix(id));
    row.addEventListener("mouseenter", () => highlightFiles(findingFiles(findById(id))));
    row.addEventListener("mouseleave", () => highlightFiles([]));
    row.addEventListener("focusin", () => {
      state.selectedId = id;
      $$(".finding.selected", col).forEach((r) => r.classList.toggle("selected", r === row));
      row.classList.add("selected");
      highlightFiles(findingFiles(findById(id)));
    });
  });
  $$("[data-file-select]", col).forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.fileSelect)));
  if (focusedId) $(`.finding[data-id="${focusedId}"] .finding-toggle`, col)?.focus({ preventScroll: true });
}

function findById(id) {
  return state.session?.findings.find((f) => f.id === id);
}

function findingRow(f) {
  const expanded = state.expanded.has(f.id);
  const evidence = (f.evidence || []).filter((e) => e.file);
  return `<li class="finding risk-${f.risk} ${state.selectedId === f.id ? "selected" : ""}" data-id="${f.id}">
      <button type="button" class="finding-toggle" aria-expanded="${expanded}" aria-controls="fd-${f.id}">
        <span class="risk-tag ${f.risk}">${RISK_LABEL[f.risk]}</span>
        <span class="finding-text">
          <span class="finding-title">${rich(f.title)}</span>
          <span class="finding-summary">${rich(f.summary)}</span>
        </span>
        ${icon("chevron-down", "chev")}
      </button>
      <div class="finding-actions">
        ${f.actionable ? `<button type="button" class="btn tinted small" data-act="fix">Fix…</button>` : ""}
        <button type="button" class="btn plain small" data-act="dismiss">Dismiss</button>
      </div>
      <div class="finding-detail" id="fd-${f.id}" ${expanded ? "" : "hidden"}>
        <p class="why"><strong>Why ${RISK_LABEL[f.risk].toLowerCase()} risk.</strong> ${rich(f.riskRationale)}</p>
        ${
          evidence.length
            ? `<p class="detail-label">Where</p><ul class="where-list">${evidence
                .map(
                  (e) => `<li><button type="button" class="file-chip" data-file-select="${escapeHtml(e.file)}" title="Show only findings for this file">${escapeHtml(e.file)}</button>
                    ${e.lines?.length ? `<span class="muted">${e.lines.length === 1 ? "line" : "lines"} ${e.lines.slice(0, 6).join(", ")}${e.lines.length > 6 ? "…" : ""}</span>` : ""}
                    ${e.note ? `<span class="note">${rich(e.note)}</span>` : ""}</li>`
                )
                .join("")}</ul>`
            : ""
        }
      </div>
    </li>`;
}

function resolvedRow(f, kind) {
  return `<li class="finding resolved" data-id="${f.id}">
      <span class="risk-tag ${f.risk}">${RISK_LABEL[f.risk]}</span>
      <span class="finding-title">${rich(f.title)}</span>
      ${kind === "dismissed" ? `<button type="button" class="btn plain small" data-act="restore">Restore</button>` : `<span class="fixed-mark">${icon("check")}Fixed</span>`}
    </li>`;
}

function toggleFinding(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  const row = $(`.finding[data-id="${id}"]`);
  if (!row) return;
  const open = state.expanded.has(id);
  $(".finding-toggle", row).setAttribute("aria-expanded", String(open));
  $(".finding-detail", row).hidden = !open;
}

function setStatus(id, status, { silent = false } = {}) {
  const f = findById(id);
  if (!f) return;
  const prev = f.status;
  const row = $(`#findingList .finding[data-id="${id}"]`);
  const nextRow = row?.nextElementSibling || row?.previousElementSibling;
  const nextId = nextRow?.dataset.id;
  const commit = () => {
    f.status = status;
    if (nextId && status !== "needs_review") state.selectedId = nextId;
    refreshReview();
    if (nextId && status !== "needs_review") $(`#findingList .finding[data-id="${nextId}"] .finding-toggle`)?.focus({ preventScroll: true });
    if (silent) return;
    if (status === "dismissed") {
      state.undo = () => setStatus(id, prev, { silent: true });
      toast(`Dismissed “${plainTitle(f)}”.`, { actionLabel: "Undo", onAction: runUndo });
    } else if (status === "needs_review" && prev === "dismissed") {
      toast(`Restored “${plainTitle(f)}”.`);
    }
  };
  if (row && !reduceMotion() && status !== "needs_review") {
    row.classList.add("leaving");
    setTimeout(commit, 200);
  } else {
    commit();
  }
}

function plainTitle(f) {
  return f.title.replace(/`/g, "");
}

function runUndo() {
  if (!state.undo) return;
  const fn = state.undo;
  state.undo = null;
  fn();
  toast("Undone.");
}

// --- Map ↔ findings -------------------------------------------------------------------

function onMapSelect(target) {
  const file = target.kind === "changed" ? target.file : target.node.file;
  setFilter(state.filterFile === file ? null : file);
}

function setFilter(file) {
  state.filterFile = file;
  refreshReview();
  if (file && window.innerWidth < 960) $("#findingsCol").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" });
}

function syncMap() {
  $$("#radarWrap .radar-node").forEach((n) => {
    const file = n.getAttribute("data-file");
    const on = !!state.filterFile && file === state.filterFile;
    n.classList.toggle("selected", on);
    n.classList.toggle("dimmed", !!state.filterFile && !on);
    n.setAttribute("aria-pressed", String(on));
  });
  $("#clearFilterMap")?.classList.toggle("hidden", !state.filterFile);
}

function highlightFiles(files) {
  $$("#radarWrap .radar-node").forEach((n) => n.classList.toggle("linked", files.includes(n.getAttribute("data-file"))));
}

// --- Fix --------------------------------------------------------------------------------

async function openFix(id) {
  const finding = findById(id);
  const s = state.session;
  openSheet({ title: "Preparing a fix…", body: `<p class="sheet-lede">Drafting a change for ${rich(finding.title)}.</p><div class="progress-bar" role="progressbar" aria-label="Preparing fix"><span></span></div>` });
  let patch;
  let problem = null;
  try {
    patch = await state.provider.generatePatch(finding, {
      ...s.evidencePackage,
      changeSignals: {
        removedFields: new Set(s.evidencePackage.changeSignals.removedFields),
        addedFields: new Set(s.evidencePackage.changeSignals.addedFields),
        touchedSymbolNames: new Set(s.evidencePackage.changeSignals.touchedSymbolNames),
        touchedRoutes: s.evidencePackage.changeSignals.touchedRoutes,
      },
    });
    if (!patch.operations?.length) problem = "There's no automatic fix for this finding. Raise it with the author instead.";
    else {
      try {
        await validatePatch({ fs: state.repo.fs, dir: state.repo.dir, patch, snapshotHashes: s.fileSnapshots });
      } catch (err) {
        if (err instanceof PatchValidationError) problem = "The file changed since this review, so this fix can't be applied safely. Review again to get an up-to-date fix.";
        else throw err;
      }
    }
  } catch (err) {
    console.error(err);
    openSheet({ title: "Couldn't prepare a fix", body: `<p class="sheet-lede">${escapeHtml(friendlyError(err, "fix"))}</p>`, actions: [{ label: "OK", primary: true }] });
    return;
  }

  const where = state.repo.dirHandle ? "Applying updates the file in your folder." : "Applying gives you the updated file as a download.";
  openSheet({
    title: "Review this fix",
    wide: true,
    body: `<p class="sheet-lede">${rich(patch.summary)}</p>
      <pre class="patch">${(patch.unifiedDiff || "")
        .split("\n")
        .map((l) => `<span class="${l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "ctx"}">${escapeHtml(l)}</span>`)
        .join("\n")}</pre>
      ${problem ? `<p class="inline-error">${icon("alert")}${escapeHtml(problem)}</p>` : `<p class="muted">${where}</p>`}`,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply Fix",
        primary: true,
        disabled: !!problem,
        onClick: async (btn) => {
          btn.disabled = true;
          btn.textContent = "Applying…";
          try {
            const applied = await applyPatch({ fs: state.repo.fs, dir: state.repo.dir, patch, snapshotHashes: s.fileSnapshots, dirHandle: state.repo.dirHandle });
            closeSheet();
            finding.status = "fixed";
            refreshReview();
            const files = Object.keys(applied.details || {});
            const names = files.map((f) => `\`${f}\``).join(", ") || "the file";
            if (state.repo.dirHandle && applied.wroteToDisk) {
              toast(`Fixed. Updated ${names}.`, { tone: "success" });
            } else {
              toast(`Fixed. Download ${names} to keep the change.`, {
                tone: "success",
                duration: 15000,
                actionLabel: "Download",
                onAction: () => files.forEach((f) => downloadFile(f.split("/").pop(), applied.details[f].content)),
              });
            }
          } catch (err) {
            console.error(err);
            btn.disabled = false;
            btn.textContent = "Apply Fix";
            const msg = err instanceof PatchValidationError ? "The file changed since this review. Review again to get an up-to-date fix." : friendlyError(err, "fix");
            $(".sheet-body").insertAdjacentHTML("beforeend", `<p class="inline-error">${icon("alert")}${escapeHtml(msg)}</p>`);
          }
          return false;
        },
      },
    ],
  });
}

// --- Sheets (modal dialogs) --------------------------------------------------------------

let sheetReturnFocus = null;
export function openSheet({ title, body, actions = [], wide = false }) {
  const root = $("#modalRoot");
  if (!root.firstChild) sheetReturnFocus = document.activeElement;
  root.innerHTML = `
    <div class="scrim" id="scrim">
      <div class="sheet ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
        <div class="sheet-head">
          <h2 id="sheetTitle">${rich(title)}</h2>
          <button type="button" class="icon-btn" id="sheetClose" aria-label="Close">${icon("close")}</button>
        </div>
        <div class="sheet-body">${body}</div>
        ${actions.length ? `<div class="sheet-actions">${actions.map((a, i) => `<button type="button" class="btn ${a.primary ? "primary" : ""}" data-sheet-act="${i}" ${a.disabled ? "disabled" : ""}>${escapeHtml(a.label)}</button>`).join("")}</div>` : ""}
      </div>
    </div>`;
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#scrim").addEventListener("mousedown", (e) => {
    if (e.target.id === "scrim") closeSheet();
  });
  actions.forEach((a, i) => {
    $(`[data-sheet-act="${i}"]`).addEventListener("click", async (e) => {
      const keep = a.onClick ? (await a.onClick(e.currentTarget)) === false : false;
      if (!keep) closeSheet();
    });
  });
  ($(".sheet-actions .btn.primary:not([disabled])") || $("#sheetClose")).focus();
}

export function closeSheet() {
  const root = $("#modalRoot");
  const scrim = root.firstElementChild;
  if (!scrim || scrim.classList.contains("leaving")) return;
  const done = () => {
    if (root.firstElementChild === scrim) root.innerHTML = "";
  };
  if (reduceMotion()) done();
  else {
    scrim.classList.add("leaving");
    setTimeout(done, 150);
  }
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
}

function trapFocus(e) {
  const sheet = $("#modalRoot .sheet");
  if (!sheet) return;
  const items = $$("button:not([disabled]), [href], input, select, textarea, summary", sheet).filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// --- Compare popover ------------------------------------------------------------------------

function openComparePopover() {
  if (!state.repo) return;
  const pop = $("#comparePopover");
  const refs = [...(state.repo.branches || []), git.REF.WORKING_TREE];
  for (const sel of [$("#baseRef"), $("#headRef")]) {
    sel.innerHTML = refs.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(refLabel(r))}</option>`).join("");
  }
  $("#baseRef").value = state.base;
  $("#headRef").value = state.head;
  validateCompare();
  pop.classList.remove("hidden");
  $("#compareBtn").setAttribute("aria-expanded", "true");
  $("#headRef").focus();
}

function closeComparePopover({ restoreFocus = true } = {}) {
  const pop = $("#comparePopover");
  if (pop.classList.contains("hidden")) return;
  pop.classList.add("hidden");
  $("#compareBtn").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#compareBtn").focus();
}

function validateCompare() {
  const same = $("#baseRef").value === $("#headRef").value;
  $("#compareNote").textContent = same ? "Choose two different branches." : "";
  $("#compareApply").disabled = same;
}

$("#compareBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#comparePopover").classList.contains("hidden")) openComparePopover();
  else closeComparePopover();
});
$("#baseRef").addEventListener("change", validateCompare);
$("#headRef").addEventListener("change", validateCompare);
$("#compareCancel").addEventListener("click", () => closeComparePopover());
$("#comparePopover").addEventListener("submit", async (e) => {
  e.preventDefault();
  closeComparePopover({ restoreFocus: false });
  state.busy = true;
  try {
    await review($("#baseRef").value, $("#headRef").value);
  } finally {
    state.busy = false;
  }
});

// --- Menus -----------------------------------------------------------------------------------

function toggleMenu(btn, menu) {
  const willOpen = menu.classList.contains("hidden");
  closeMenus();
  if (!willOpen) return;
  menu.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  $("[role=menuitem]", menu)?.focus();
}

function closeMenus() {
  $$(".menu").forEach((m) => m.classList.add("hidden"));
  $$("[aria-haspopup=menu]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

for (const [btnId, menuId] of [["helpBtn", "helpMenu"], ["moreBtn", "moreMenu"]]) {
  const btn = $(`#${btnId}`);
  const menu = $(`#${menuId}`);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(btn, menu);
  });
  menu.addEventListener("click", () => closeMenus());
  menu.addEventListener("keydown", (e) => {
    const items = $$("[role=menuitem]", menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === "Escape") {
      closeMenus();
      btn.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenus();
  if (!e.target.closest(".compare-wrap")) closeComparePopover({ restoreFocus: false });
});

// --- Sharing -----------------------------------------------------------------------------------

function reviewMarkdown() {
  const s = state.session;
  const v = verdictFor(s);
  const open = s.findings.filter((f) => f.status === "needs_review").sort(byRisk);
  const fixed = s.findings.filter((f) => f.status === "fixed");
  const row = (f) => `- **${RISK_LABEL[f.risk]} — ${f.title}**\n  ${f.summary}`;
  const lines = [
    `## ${v.title}`,
    v.sub,
    "",
    `Reviewed \`${refLabel(state.head)}\` into \`${refLabel(state.base)}\` in **${state.repo.name}** · ${s.diffSummary.filesChanged} files changed (+${s.diffSummary.additions} / −${s.diffSummary.deletions}) · ${s.radar.nodes.length} files affected`,
    "",
  ];
  if (s.analysis?.intent) lines.push("### What this change does", s.analysis.intent, "");
  lines.push(`### Needs attention (${open.length})`, ...(open.length ? open.map(row) : ["Nothing open."]), "");
  if (fixed.length) lines.push(`### Fixed (${fixed.length})`, ...fixed.map(row), "");
  const qs = s.analysis?.reviewQuestions || [];
  if (qs.length) lines.push("### Questions for the author", ...qs.map((q, i) => `${i + 1}. ${q}`), "");
  lines.push("_Reviewed with DiffLens._");
  return lines.join("\n");
}

async function copyReview() {
  if (!state.session) return;
  const btn = $("#copyReviewBtn");
  try {
    await navigator.clipboard.writeText(reviewMarkdown());
    btn.classList.add("done");
    btn.innerHTML = `${icon("check")}Copied`;
    toast("Review copied. Paste it into the pull request.", { tone: "success" });
    setTimeout(() => {
      btn.classList.remove("done");
      btn.innerHTML = `${icon("copy")}Copy Review`;
    }, 2000);
  } catch {
    toast("Your browser blocked copying. Use Download Review in the More menu instead.", { tone: "error" });
  }
}

$("#copyReviewBtn").addEventListener("click", copyReview);
$("#downloadReviewBtn").addEventListener("click", () => {
  if (!state.session) return toast("Open a repository first.", { tone: "error" });
  downloadFile(`${state.repo.name}-review.md`, reviewMarkdown(), "text/markdown");
  toast(`Downloaded \`${state.repo.name}-review.md\`.`, { tone: "success" });
});
$("#downloadEvidenceBtn").addEventListener("click", async () => {
  if (!state.session) return toast("Open a repository first.", { tone: "error" });
  try {
    const docs = renderEvidenceDocs(state.session);
    const fflate = await import("../vendor/fflate.js");
    const files = {};
    for (const [name, content] of Object.entries(docs)) files[`bob-code-review/${name}`] = new TextEncoder().encode(content);
    downloadFile("bob-code-review.zip", new Blob([fflate.zipSync(files)], { type: "application/zip" }));
    toast("Downloaded `bob-code-review.zip` — the full evidence behind this review.", { tone: "success" });
  } catch (err) {
    console.error(err);
    toast("The evidence file couldn't be created. Try again.", { tone: "error" });
  }
});
$("#openAnotherBtn").addEventListener("click", () => {
  showView("open");
  setOpenStatus("");
  $("#chooseFolderBtn").focus();
});

// --- Settings --------------------------------------------------------------------------------

function applyProvider(settings) {
  try {
    state.provider = createBrowserProvider(settings);
  } catch {
    state.provider = createBrowserProvider({ kind: "mock" });
  }
}

$("#settingsBtn").addEventListener("click", () => {
  const s = loadAISettings();
  const kind = s.kind || "mock";
  openSheet({
    title: "Settings",
    body: `
      <fieldset class="choice-group">
        <legend>Analysis engine</legend>
        <label class="choice"><input type="radio" name="aiKind" value="mock" ${kind === "mock" ? "checked" : ""} />
          <span><strong>Built-in</strong><small>Works offline. No account or key needed.</small></span></label>
        <label class="choice"><input type="radio" name="aiKind" value="huggingface" ${kind === "huggingface" ? "checked" : ""} />
          <span><strong>Hugging Face</strong><small>A hosted model, using your access token.</small></span></label>
        <label class="choice"><input type="radio" name="aiKind" value="openai-compatible" ${kind === "openai-compatible" ? "checked" : ""} />
          <span><strong>Other service</strong><small>Any OpenAI-compatible endpoint.</small></span></label>
      </fieldset>
      <div class="provider-fields" id="providerFields">
        <label for="aiApiKey">Access token</label>
        <input id="aiApiKey" type="password" autocomplete="off" value="${escapeHtml(s.apiKey || "")}" placeholder="Paste your token" />
        <details class="advanced"><summary>Advanced</summary>
          <label for="aiBaseUrl">Endpoint URL</label>
          <input id="aiBaseUrl" type="url" value="${escapeHtml(s.baseUrl || "")}" placeholder="https://router.huggingface.co/v1" />
          <label for="aiModel">Model</label>
          <input id="aiModel" type="text" value="${escapeHtml(s.model || "")}" placeholder="Qwen/Qwen2.5-Coder-1.5B-Instruct" />
        </details>
        <p class="fine-print">Your token stays in this browser and is sent only to the service you choose.</p>
      </div>`,
    actions: [
      { label: "Cancel" },
      {
        label: "Save",
        primary: true,
        onClick: () => {
          const chosen = $("input[name=aiKind]:checked").value;
          const next = { kind: chosen, apiKey: $("#aiApiKey").value, baseUrl: $("#aiBaseUrl").value.trim(), model: $("#aiModel").value.trim() };
          if (chosen !== "mock" && !next.apiKey) {
            $("#aiApiKey").setAttribute("aria-invalid", "true");
            if (!$("#tokenError")) $("#aiApiKey").insertAdjacentHTML("afterend", `<p class="inline-error" id="tokenError">${icon("alert")}Enter an access token to use this service.</p>`);
            $("#aiApiKey").focus();
            return false;
          }
          saveAISettings(next);
          applyProvider(next);
          toast("Settings saved.", state.session ? { tone: "success", actionLabel: "Review Again", onAction: () => review(state.base, state.head) } : { tone: "success" });
        },
      },
    ],
  });
  const sync = () => ($("#providerFields").hidden = $("input[name=aiKind]:checked").value === "mock");
  $$("input[name=aiKind]").forEach((r) => r.addEventListener("change", sync));
  sync();
});

// --- Help --------------------------------------------------------------------------------------

const SHORTCUTS = [
  ["J", "Next finding"],
  ["K", "Previous finding"],
  ["Enter", "Show or hide details"],
  ["D", "Dismiss finding"],
  ["F", "Fix finding"],
  ["Z", "Undo"],
  ["C", "Copy review"],
  ["Esc", "Clear filter or close"],
  ["?", "Show shortcuts"],
];

function showShortcuts() {
  openSheet({
    title: "Keyboard shortcuts",
    body: `<dl class="shortcut-list">${SHORTCUTS.map(([k, d]) => `<div><dt><kbd>${k}</kbd></dt><dd>${d}</dd></div>`).join("")}</dl>`,
    actions: [{ label: "Done", primary: true }],
  });
}

async function startTourFromHelp() {
  const { startTour } = await import("./tour.js");
  startTour();
}

$$("[data-help]").forEach((b) => b.addEventListener("click", () => (b.dataset.help === "shortcuts" ? showShortcuts() : startTourFromHelp())));

// --- Keyboard ---------------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && $("#modalRoot").firstChild) return trapFocus(e);
  if (e.key === "Escape") {
    if ($("#modalRoot").firstChild) return closeSheet();
    if (!$("#comparePopover").classList.contains("hidden")) return closeComparePopover();
    if (state.filterFile) return setFilter(null);
    return;
  }
  const typing = e.target.closest?.("input, select, textarea, [contenteditable]");
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $("#modalRoot").firstChild || document.querySelector(".tour-card")) return;
  if (e.key === "?") {
    e.preventDefault();
    return showShortcuts();
  }
  if (document.body.dataset.stage !== "results" || !state.session) return;
  const rows = $$("#findingList .finding");
  const idx = rows.findIndex((r) => r.dataset.id === state.selectedId);
  const select = (i) => {
    const row = rows[Math.max(0, Math.min(i, rows.length - 1))];
    if (!row) return;
    $(".finding-toggle", row).focus();
    row.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  };
  const key = e.key.toLowerCase();
  if (key === "j") {
    e.preventDefault();
    select(idx + 1);
  } else if (key === "k") {
    e.preventDefault();
    select(idx < 0 ? 0 : idx - 1);
  } else if (key === "d" && findById(state.selectedId)?.status === "needs_review") {
    setStatus(state.selectedId, "dismissed");
  } else if (key === "f" && findById(state.selectedId)?.actionable && findById(state.selectedId)?.status === "needs_review") {
    openFix(state.selectedId);
  } else if (key === "z") {
    runUndo();
  } else if (key === "c") {
    copyReview();
  }
});

// --- Appearance ----------------------------------------------------------------------------------

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  else root.removeAttribute("data-theme");
  $$("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice)));
  try {
    if (choice === "system") localStorage.removeItem("difflens-theme");
    else localStorage.setItem("difflens-theme", choice);
  } catch {
    // Storage unavailable: the choice lasts for this visit.
  }
}
const themeButtons = $$("[data-theme-choice]");
themeButtons.forEach((btn, i) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice));
  btn.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = themeButtons[(i + step + themeButtons.length) % themeButtons.length];
    applyTheme(next.dataset.themeChoice);
    next.focus();
  });
});
applyTheme(document.documentElement.getAttribute("data-theme") || "system");

// --- Landing ----------------------------------------------------------------------------------

$("#homeBtn").addEventListener("click", showLanding);
$("#heroSampleBtn").addEventListener("click", () => openSample());
$("#getStartedBtn").addEventListener("click", () => {
  openSheet({
    title: "Would you like a quick tour?",
    body: `<p class="sheet-lede">It takes about a minute and uses a sample repository, so you don't need one of your own. You can start it again anytime from Help.</p>`,
    actions: [
      { label: "No Thanks", onClick: () => enterApp() },
      {
        label: "Show Me Around",
        primary: true,
        onClick: () => {
          enterApp();
          startTourFromHelp();
        },
      },
    ],
  });
});

function enterApp() {
  showView(state.session ? "results" : "open");
}

// --- Start ------------------------------------------------------------------------------------

window.addEventListener("offline", () => toast("You're offline. Folders, .zip files, and the sample still work.", { tone: "error" }));
window.addEventListener("online", () => toast("Back online.", { tone: "success", duration: 3000 }));
applyProvider(loadAISettings());
hydrateIcons(document);
document.body.dataset.view = "landing";
