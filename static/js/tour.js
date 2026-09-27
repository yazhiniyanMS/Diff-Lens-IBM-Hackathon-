// Guided tour. Each step spotlights a real part of the app; the page stays
// usable underneath, so people can follow along with the real controls.
import { showView, openSample, state, toast } from "./app.js";

const $ = (sel) => document.querySelector(sel);
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isVisible = (sel) => {
  const el = $(sel);
  return !!el && el.getClientRects().length > 0;
};

const STEPS = [
  {
    target: "#dropzone",
    title: "Start with a repository",
    body: "Drop a project folder or .zip here, or choose one. For this tour we'll open a small sample with one change waiting for review.",
    cta: "Open the Sample",
    action: () => openSample(),
    waitFor: "results",
  },
  {
    target: "#verdict",
    title: "The answer comes first",
    body: "DiffLens picked the branches, traced the change, and decided whether it's safe to merge. The verdict updates as you work through the findings.",
  },
  {
    target: "#findingsCol .findings-card",
    title: "What needs attention",
    body: "Findings are sorted by risk. Select one to see why it matters and where. Dismiss anything that doesn't apply — Undo is always one click away.",
  },
  {
    target: "#mapSection",
    title: "Everything the change reaches",
    body: "The changed files sit in the center. Select any file on the map to see only its findings.",
  },
  {
    target: ".compare-wrap",
    title: "Branches are chosen for you",
    body: "DiffLens compared the newest branch with main. Select this to review a different pair.",
  },
  {
    target: "#copyReviewBtn",
    title: "Share the review",
    body: "Copy the verdict and findings, then paste them into the pull request.",
  },
  {
    target: ".header-actions",
    title: "That's everything",
    body: "Switch appearance here. Help has this tour and the keyboard shortcuts.",
    cta: "Done",
  },
];

let tour = null;

export function startTour() {
  endTour();
  showView(state.session ? "results" : "open");
  tour = { index: 0, waiting: null };
  const layer = document.createElement("div");
  layer.className = "tour-layer";
  layer.innerHTML = `
    <div class="tour-spotlight" id="tourSpotlight"></div>
    <div class="tour-card" id="tourCard" role="dialog" aria-modal="false" aria-labelledby="tourTitle" aria-describedby="tourBody">
      <p class="tour-count" id="tourCount"></p>
      <h2 id="tourTitle"></h2>
      <p id="tourBody"></p>
      <p class="tour-status" id="tourStatus" role="status"></p>
      <div class="tour-actions">
        <button type="button" class="btn plain small" id="tourSkip">End Tour</button>
        <span class="spacer"></span>
        <button type="button" class="btn small" id="tourBack">Back</button>
        <button type="button" class="btn primary small" id="tourNext"></button>
      </div>
    </div>`;
  document.body.appendChild(layer);
  tour.layer = layer;
  $("#tourSkip").addEventListener("click", endTour);
  $("#tourBack").addEventListener("click", () => goTo(tour.index - 1, -1));
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
  tour.onLayout = () => position();
  document.addEventListener("difflens:step", tour.onStep);
  document.addEventListener("keydown", tour.onKey);
  window.addEventListener("resize", tour.onLayout);
  window.addEventListener("scroll", tour.onLayout, { passive: true });
  goTo(state.session ? 1 : 0);
}

export function endTour() {
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
  if (tour.index === STEPS.length - 1) {
    endTour();
    toast("Tour complete — you're ready to review your own changes.", { tone: "success" });
    return;
  }
  if (step.action && step.waitFor) {
    tour.waiting = step.waitFor;
    const btn = $("#tourNext");
    btn.disabled = true;
    btn.textContent = "Opening…";
    const at = tour.index;
    step.action();
    setTimeout(() => {
      if (tour && tour.index === at && tour.waiting) {
        tour.waiting = null;
        btn.disabled = false;
        btn.textContent = "Try Again";
        $("#tourStatus").textContent = "That took longer than expected. Check the message on the page, then try again.";
      }
    }, 20000);
    return;
  }
  goTo(tour.index + 1);
}

function goTo(index, dir = 1) {
  if (!tour) return;
  let i = Math.max(0, Math.min(index, STEPS.length - 1));
  while (i > 0 && i < STEPS.length - 1 && !isVisible(STEPS[i].target)) i += dir;
  tour.index = i;
  tour.waiting = null;
  const step = STEPS[i];
  $("#tourCount").textContent = `${i + 1} of ${STEPS.length}`;
  $("#tourTitle").textContent = step.title;
  $("#tourBody").textContent = step.body;
  $("#tourStatus").textContent = "";
  const next = $("#tourNext");
  next.textContent = step.cta || "Next";
  next.disabled = false;
  $("#tourBack").disabled = i === 0 || (i === 1 && !!state.session && !isVisible("#dropzone"));
  $(step.target)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
  position();
  setTimeout(position, reduceMotion() ? 0 : 400);
  next.focus({ preventScroll: true });
}

function position() {
  if (!tour) return;
  const target = $(STEPS[tour.index].target);
  const spot = $("#tourSpotlight");
  const card = $("#tourCard");
  if (!target) return;
  const pad = 8;
  const r = target.getBoundingClientRect();
  const top = Math.max(r.top - pad, 4);
  const bottom = Math.min(r.bottom + pad, window.innerHeight - 4);
  Object.assign(spot.style, { top: `${top}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${Math.max(bottom - top, 0)}px` });

  if (window.innerWidth < 720) {
    card.classList.add("docked");
    card.style.left = card.style.top = "";
    return;
  }
  card.classList.remove("docked");
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const gap = 16;
  const clampTop = (t) => Math.min(Math.max(t, 72), window.innerHeight - ch - 12);
  let left;
  let cardTop;
  if (r.right + gap + cw < window.innerWidth - 12) {
    left = r.right + gap;
    cardTop = clampTop(r.top);
  } else if (r.left - gap - cw > 12) {
    left = r.left - gap - cw;
    cardTop = clampTop(r.top);
  } else {
    left = Math.min(Math.max(r.left, 12), window.innerWidth - cw - 12);
    cardTop = r.bottom + gap + ch < window.innerHeight ? r.bottom + gap : clampTop(r.top - gap - ch);
  }
  card.style.left = `${left}px`;
  card.style.top = `${cardTop}px`;
}
