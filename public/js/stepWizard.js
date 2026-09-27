(() => {
  const panels = ["loadRepoPanel", "compareSection", "analyzeSection", "summarySection"];
  const dots = () => document.querySelectorAll(".step-dot");
  const lines = () => document.querySelectorAll(".step-line");

  function isVisible(el) {
    if (!el || el.classList.contains("hidden")) return false;
    return window.getComputedStyle(el).display !== "none";
  }

  function currentStep() {
    for (let i = panels.length - 1; i >= 0; i--) {
      if (isVisible(document.getElementById(panels[i]))) return i + 1;
    }
    return 1;
  }

  function render() {
    const step = currentStep();
    panels.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("step-collapsed", idx + 1 !== step && isVisible(el) === false ? el.classList.contains("step-collapsed") : idx + 1 !== step);
    });
    dots().forEach((d, idx) => {
      d.classList.toggle("active", idx + 1 === step);
      d.classList.toggle("done", idx + 1 < step);
    });
    lines().forEach((l, idx) => l.classList.toggle("done", idx + 1 < step));
  }

  panels.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    new MutationObserver(render).observe(el, { attributes: true, attributeFilter: ["style", "class"] });
  });

  dots().forEach((d, idx) => {
    d.addEventListener("click", () => {
      const el = document.getElementById(panels[idx]);
      if (!isVisible(el) && !el.classList.contains("step-collapsed")) return;
      panels.forEach((id2, idx2) => {
        const el2 = document.getElementById(id2);
        if (el2) el2.classList.toggle("step-collapsed", idx2 !== idx);
      });
      dots().forEach((dd, ii) => dd.classList.toggle("active", ii === idx));
    });
  });

  render();
})();
