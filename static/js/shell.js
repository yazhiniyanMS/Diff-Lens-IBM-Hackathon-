// Landing page, appearance switch, and the guided tutorial.
const $ = (sel) => document.querySelector(sel);
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- Appearance ----------------------------------------------------------------

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  else root.removeAttribute("data-theme");
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.themeChoice === choice));
  });
  try {
    if (choice === "system") localStorage.removeItem("difflens-theme");
    else localStorage.setItem("difflens-theme", choice);
  } catch {
    // Storage unavailable: the choice lasts for this visit only.
  }
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "system";
}

const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
themeButtons.forEach((btn, i) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice));
  btn.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = themeButtons[(i + step + themeButtons.length) % themeButtons.length];
    applyTheme(next.dataset.themeChoice);
    next.focus();
  });
});
applyTheme(currentTheme());

// --- Landing ↔ app -----------------------------------------------------------------

function showApp() {
  $("#landing").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  document.body.classList.add("in-app");
  window.scrollTo(0, 0);
}

function showLanding() {
  endTour();
  $("#appView").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  document.body.classList.remove("in-app");
  window.scrollTo(0, 0);
}

$("#homeBtn").addEventListener("click", showLanding);
$("#tutorialBtn").addEventListener("click", () => startTour());
$("#getStartedBtn").addEventListener("click", askAboutTutorial);

function askAboutTutorial() {
  const root = $("#modalRoot");
  const previousFocus = document.activeElement;
  root.innerHTML = `
    <div class="modal-backdrop" id="welcomeBackdrop">
      <div class="modal welcome-sheet" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle" aria-describedby="welcomeText">
        <div class="welcome-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="var(--info-dim)"/><path d="M17 24.5l5 5 9-11" fill="none" stroke="var(--info)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h3 id="welcomeTitle">Would you like a quick tour?</h3>
        <p id="welcomeText" class="modal-lede">It takes about a minute and uses a sample repository, so you don't need one of your own. You can open it again anytime from Tutorial.</p>
        <div class="sheet-actions">
          <button type="button" id="skipTourBtn">No Thanks</button>
          <button type="button" class="primary" id="startTourBtn">Show Me Around</button>
        </div>
      </div>
    </div>`;
  const close = () => {
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
      if (previousFocus?.focus) previousFocus.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  $("#skipTourBtn").addEventListener("click", () => {
    close();
    showApp();
  });
  $("#startTourBtn").addEventListener("click", () => {
    close();
    showApp();
    startTour();
  });
  $("#welcomeBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "welcomeBackdrop") close();
  });
  $("#startTourBtn").focus();
}

// --- Guided tutorial ---------------------------------------------------------------
// Each step spotlights a real part of the app. Steps with `action` do the
// step for the person when they press the primary button, then wait for the
// app to report that step finished (`difflens:step`) before moving on. People
// can also just use the real control themselves; the tour follows along.

const isVisible = (sel) => {
  const el = $(sel);
  return !!el && el.offsetParent !== null && !el.classList.contains("hidden");
};

const STEPS = [
  {
    target: "#loadPanel",
    title: "Start with a repository",
    body: "Choose a folder or a .zip of any git repository. For this tour we'll use a small sample project with one pull request waiting for review.",
    cta: "Load the Sample",
    action: () => $("#sampleBtn").click(),
    waitFor: "repo",
  },
  {
    target: "#compareSection",
    title: "Pick what to compare",
    body: "Base is the branch you're merging into. Compare is the change under review — we've already picked the sample's feature branch.",
    cta: "Show the Diff",
    action: () => $("#loadDiffBtn").click(),
    waitFor: "diff",
  },
  {
    target: "#diffPanel",
    title: "This is all a normal review sees",
    body: "Four lines renamed one field. Looks harmless — but nothing here tells you who else depends on that field.",
    cta: "Next",
  },
  {
    target: "#analyzeSection",
    title: "Analyze the change",
    body: "DiffLens now traces the changed names through tests, docs, services, and API consumers across the whole repository.",
    cta: "Analyze",
    action: () => $("#analyzeBtn").click(),
    waitFor: "analysis",
  },
  {
    target: "#radarPanel",
    title: "The blast radius",
    body: "The changed files sit in the middle. Every ring is a kind of file the change reaches. Red means it needs attention — select any file to see the evidence.",
    cta: "Next",
  },
  {
    target: "#briefPanel",
    title: "The review brief",
    body: "Findings are grouped by topic. Accept or dismiss each one, or choose Suggest Fix to preview a patch before applying it.",
    cta: "Next",
  },
  {
    target: "#summarySection",
    title: "Share the review",
    body: "When you're ready, turn everything into one summary you can paste into the pull request.",
    cta: "Generate Summary",
    action: () => $("#genSummaryBtn").click(),
    waitFor: "summary",
  },
  {
    target: "#summaryPanel",
    title: "Your merge verdict",
    body: "The verdict and lists update as you triage findings. Use Copy Markdown to paste it into GitHub.",
    cta: "Next",
  },
  {
    target: ".header-actions",
    title: "You're all set",
    body: "Switch between Light, Dark, and System appearance here, and reopen this tour anytime from Tutorial.",
    cta: "Done",
  },
];

let tour = null;

function startTour() {
  endTour();
  showApp();
  tour = { index: 0, waiting: null };
  const layer = document.createElement("div");
  layer.className = "tour-layer";
  layer.innerHTML = `
    <div class="tour-spotlight" id="tourSpotlight"></div>
    <div class="tour-card" id="tourCard" role="dialog" aria-modal="false" aria-labelledby="tourTitle" aria-describedby="tourBody">
      <div class="tour-progress" id="tourProgress" aria-hidden="true"></div>
      <p class="tour-count" id="tourCount"></p>
      <h3 id="tourTitle"></h3>
      <p id="tourBody"></p>
      <p class="tour-status" id="tourStatus" role="status"></p>
      <div class="tour-actions">
        <button type="button" class="ghost small" id="tourSkip">End Tour</button>
        <span class="spacer"></span>
        <button type="button" class="small" id="tourBack">Back</button>
        <button type="button" class="primary small" id="tourNext"></button>
      </div>
    </div>`;
  document.body.appendChild(layer);
  tour.layer = layer;
  $("#tourSkip").addEventListener("click", endTour);
  $("#tourBack").addEventListener("click", () => goTo(tour.index - 1));
  $("#tourNext").addEventListener("click", onNext);
  tour.onStep = (e) => {
    if (tour?.waiting && e.detail === tour.waiting) {
      tour.waiting = null;
      goTo(tour.index + 1);
    }
  };
  tour.onKey = (e) => {
    if (e.key === "Escape") endTour();
  };
  tour.onLayout = () => positionTour();
  document.addEventListener("difflens:step", tour.onStep);
  document.addEventListener("keydown", tour.onKey);
  window.addEventListener("resize", tour.onLayout);
  window.addEventListener("scroll", tour.onLayout, { passive: true });

  // Resume from wherever the person already is.
  let start = 0;
  if (isVisible("#compareSection")) start = 1;
  if (isVisible("#analyzeSection")) start = 3;
  if (isVisible("#radarPanel")) start = 4;
  goTo(start);
}

function endTour() {
  if (!tour) return;
  document.removeEventListener("difflens:step", tour.onStep);
  document.removeEventListener("keydown", tour.onKey);
  window.removeEventListener("resize", tour.onLayout);
  window.removeEventListener("scroll", tour.onLayout);
  tour.layer.remove();
  tour = null;
}

function onNext() {
  const step = STEPS[tour.index];
  if (tour.index === STEPS.length - 1) return endTour();
  if (step.action && step.waitFor) {
    tour.waiting = step.waitFor;
    $("#tourNext").disabled = true;
    $("#tourStatus").textContent = "Working on it…";
    const at = tour.index;
    step.action();
    setTimeout(() => {
      if (tour && tour.index === at && tour.waiting) {
        tour.waiting = null;
        $("#tourNext").disabled = false;
        $("#tourNext").textContent = "Try Again";
        $("#tourStatus").textContent = "That step didn't finish — check the message in the highlighted panel.";
      }
    }, 20000);
    return;
  }
  goTo(tour.index + 1);
}

function goTo(index) {
  if (!tour) return;
  let i = Math.max(0, Math.min(index, STEPS.length - 1));
  // Skip steps whose target isn't on screen (for example, an empty result).
  while (i < STEPS.length - 1 && !isVisible(STEPS[i].target)) i++;
  tour.index = i;
  tour.waiting = null;
  const step = STEPS[i];
  $("#tourCount").textContent = `Step ${i + 1} of ${STEPS.length}`;
  $("#tourTitle").textContent = step.title;
  $("#tourBody").textContent = step.body;
  $("#tourStatus").textContent = "";
  const next = $("#tourNext");
  next.textContent = step.cta;
  next.disabled = false;
  $("#tourBack").disabled = i === 0;
  $("#tourProgress").innerHTML = STEPS.map((_, n) => `<span class="${n <= i ? "on" : ""}"></span>`).join("");

  const target = $(step.target);
  if (target) target.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
  positionTour();
  // Smooth scrolling moves the target after this frame; settle once it stops.
  setTimeout(positionTour, reduceMotion() ? 0 : 450);
  next.focus({ preventScroll: true });
}

function positionTour() {
  if (!tour) return;
  const step = STEPS[tour.index];
  const target = $(step.target);
  const spot = $("#tourSpotlight");
  const card = $("#tourCard");
  if (!target) return;
  const pad = 8;
  const r = target.getBoundingClientRect();
  const top = Math.max(r.top - pad, 4);
  const bottom = Math.min(r.bottom + pad, window.innerHeight - 4);
  Object.assign(spot.style, {
    top: `${top}px`,
    left: `${r.left - pad}px`,
    width: `${r.width + pad * 2}px`,
    height: `${Math.max(bottom - top, 0)}px`,
  });

  if (window.innerWidth < 720) {
    card.classList.add("docked");
    card.style.cssText = "";
    return;
  }
  card.classList.remove("docked");
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const gap = 16;
  let left;
  let cardTop;
  if (r.right + gap + cw < window.innerWidth - 12) {
    left = r.right + gap;
    cardTop = Math.min(Math.max(r.top, 72), window.innerHeight - ch - 12);
  } else if (r.left - gap - cw > 12) {
    left = r.left - gap - cw;
    cardTop = Math.min(Math.max(r.top, 72), window.innerHeight - ch - 12);
  } else {
    left = Math.min(Math.max(r.left, 12), window.innerWidth - cw - 12);
    cardTop = r.bottom + gap + ch < window.innerHeight ? r.bottom + gap : Math.max(r.top - gap - ch, 72);
  }
  card.style.left = `${left}px`;
  card.style.top = `${cardTop}px`;
}
