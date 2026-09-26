(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    repoPath: "",
    repoInfo: null,
    base: null,
    head: null,
    session: null,
  };

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { "content-type": "application/json" },
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.classList.remove("error", "ok");
    if (kind) el.classList.add(kind);
  }

  // --- Repo validate --------------------------------------------------------

  $("#validateBtn").addEventListener("click", async () => {
    const repoPath = $("#repoPath").value.trim();
    const statusEl = $("#repoStatus");
    if (!repoPath) return setStatus(statusEl, "Enter a repository path.", "error");
    setStatus(statusEl, "Validating…");
    try {
      const info = await api("/repos/validate", { method: "POST", body: JSON.stringify({ repoPath }) });
      if (!info.valid) return setStatus(statusEl, info.reason || "Not a valid git repository.", "error");
      state.repoPath = repoPath;
      state.repoInfo = info;
      setStatus(statusEl, `✓ ${info.name} · current: ${info.currentRef}`, "ok");
      populateRefSelects(info);
      $("#compareSection").style.display = "block";
      $("#analyzeSection").style.display = "none";
      $("#diffPanel").classList.add("hidden");
      $("#providerHint")?.remove();
    } catch (err) {
      setStatus(statusEl, err.message, "error");
    }
  });

  function populateRefSelects(info) {
    const baseSel = $("#baseRef");
    const headSel = $("#headRef");
    baseSel.innerHTML = "";
    headSel.innerHTML = "";
    for (const ref of info.refOptions) {
      baseSel.appendChild(new Option(refLabel(ref), ref));
      headSel.appendChild(new Option(refLabel(ref), ref));
    }
    const mainLike = info.branches.find((b) => b === "main" || b === "master") || info.branches[0];
    const base = mainLike || "WORKING";
    baseSel.value = base;

    // Head must default to something that actually differs from base, or
    // the first analysis a new user runs silently compares a branch to
    // itself and produces an empty diff. Prefer: current checked-out ref
    // (if different from base) -> another branch (most likely the real PR
    // to review) -> working tree -> staged, as a last resort.
    const candidates = [];
    if (info.currentRef && info.branches.includes(info.currentRef) && info.currentRef !== base) {
      candidates.push(info.currentRef);
    }
    const otherBranch = info.branches.find((b) => b !== base);
    if (otherBranch) candidates.push(otherBranch);
    candidates.push("WORKING", "STAGED");

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
    if (ref === "WORKING") return "Working tree (uncommitted changes)";
    if (ref === "STAGED") return "Staged changes";
    return ref;
  }

  // --- Diff inspection --------------------------------------------------------

  $("#loadDiffBtn").addEventListener("click", async () => {
    const base = $("#baseRef").value;
    const head = $("#headRef").value;
    const statusEl = $("#diffStatus");
    setStatus(statusEl, "Loading diff…");
    try {
      const { diffText } = await api(
        `/repos/diff?repoPath=${encodeURIComponent(state.repoPath)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`
      );
      state.base = base;
      state.head = head;
      renderDiff(diffText);
      $("#diffPanel").classList.remove("hidden");
      $("#analyzeSection").style.display = "block";
      if (!diffText.trim()) {
        setStatus(statusEl, "No differences between these two refs.", "error");
      } else {
        setStatus(statusEl, "Diff loaded. This is what a line-oriented review would see.", "ok");
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

  // --- Analyze ------------------------------------------------------------

  $("#analyzeBtn").addEventListener("click", async () => {
    const btn = $("#analyzeBtn");
    const statusEl = $("#analyzeStatus");
    btn.disabled = true;
    setStatus(statusEl, "Parsing diff, extracting symbols, gathering repository context, running AI analysis…");
    try {
      const session = await api("/analyze", {
        method: "POST",
        body: JSON.stringify({ repoPath: state.repoPath, base: state.base, head: state.head }),
      });
      state.session = session;
      $("#providerPill").textContent = `provider: ${session.provider}`;
      renderSession(session);
      if (session.empty) {
        setStatus(statusEl, "No changes to analyze — base and head are identical. Pick a different head above.", "error");
      } else {
        setStatus(statusEl, "Analysis complete.", "ok");
        $("#summarySection").classList.remove("hidden");
      }
    } catch (err) {
      setStatus(statusEl, err.message, "error");
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
      $("#emptyState").textContent = "No changes between the selected base and head — nothing to analyze.";
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
      ? related.map((f) => findingCardHtml(f, session)).join("")
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

  // --- Review Brief ---------------------------------------------------------

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
        body.innerHTML = findings.length
          ? findings.map((f) => findingCardHtml(f, session)).join("")
          : `<p style="color:var(--text-2)">No findings in this category.</p>`;
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
          <span class="finding-status-pill">${f.status.replace("_", " ")}</span>
          <button class="small" data-action="accept">Accept</button>
          <button class="small" data-action="dismiss">Dismiss</button>
          <button class="small" data-action="needs_review">Needs review</button>
          ${f.actionable ? `<button class="small primary" data-action="fix">Suggest Fix</button>` : ""}
        </div>
      </div>`;
  }

  function attachFindingHandlers(session) {
    document.querySelectorAll(".finding").forEach((card) => {
      const findingId = card.dataset.findingId;
      card.querySelectorAll("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const action = btn.dataset.action;
          if (action === "fix") return openFixModal(session, findingId);
          const statusMap = { accept: "accepted", dismiss: "dismissed", needs_review: "needs_review" };
          try {
            const finding = await api(`/sessions/${session.id}/findings/${findingId}/decision`, {
              method: "POST",
              body: JSON.stringify({ status: statusMap[action] }),
            });
            const idx = session.findings.findIndex((f) => f.id === findingId);
            session.findings[idx] = finding;
            renderBrief(session);
            const wrap = $("#radarSvgWrap");
            window.DiffLensRadar.renderRadar(wrap, session.radar, (t) => showNodeModal(session, t));
          } catch (err) {
            alert(err.message);
          }
        });
      });
    });
  }

  // --- Fix Mode --------------------------------------------------------------

  async function openFixModal(session, findingId) {
    const finding = session.findings.find((f) => f.id === findingId);
    openModal("Generating patch…", `<p style="color:var(--text-2)">Asking ${escapeHtml(session.provider)} for a fix for “${escapeHtml(finding.title)}”…</p>`);
    try {
      const record = await api(`/sessions/${session.id}/findings/${findingId}/patch`, { method: "POST", body: "{}" });
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
          const applied = await api(`/sessions/${session.id}/patches/${record.id}/apply`, { method: "POST", body: "{}" });
          setStatus(statusEl, `Applied. Touched: ${applied.appliedResult.touchedFiles.join(", ") || "(no changes needed)"}`, "ok");
          const idx = session.findings.findIndex((f) => f.id === record.findingId);
          if (idx !== -1) session.findings[idx].status = "fixed";
          renderBrief(session);
        } catch (err) {
          setStatus(statusEl, err.message, "error");
        }
      });
    }
  }

  // --- Reviewer summary / evidence docs ---------------------------------------

  $("#genSummaryBtn").addEventListener("click", async () => {
    if (!state.session) return;
    const { markdown } = await api(`/sessions/${state.session.id}/summary`);
    const box = $("#summaryBox");
    box.textContent = markdown;
    box.classList.remove("hidden");
  });

  $("#genEvidenceBtn").addEventListener("click", async () => {
    if (!state.session) return;
    const statusEl = $("#evidenceStatus");
    setStatus(statusEl, "Writing evidence docs…");
    try {
      const result = await api(`/sessions/${state.session.id}/evidence`, { method: "POST", body: "{}" });
      setStatus(statusEl, `Written to ${result.outDir}`, "ok");
    } catch (err) {
      setStatus(statusEl, err.message, "error");
    }
  });

  // --- Modal -------------------------------------------------------------------

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

  // --- Init --------------------------------------------------------------------

  (async () => {
    try {
      const health = await api("/health");
      $("#providerPill").textContent = `provider: ${health.provider}`;
    } catch {
      $("#providerPill").textContent = "provider: unavailable";
    }
  })();
})();
