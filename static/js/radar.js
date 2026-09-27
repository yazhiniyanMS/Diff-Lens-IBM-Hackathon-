// Review Radar rendering. Pure SVG, no charting library. Every node placed
// here comes from the analysis session's radar graph (server/lib/relationshipGraph.js)
// — this is not decorative, it mirrors real evidence-backed relationships.
//
// Accessibility: status is never conveyed by color alone (each status gets
// its own glyph + text label), every node is keyboard-focusable and
// activatable with Enter/Space, and carries an accessible name via
// aria-label/<title> (accessibility.md: "Convey information with more than
// color alone" and interfaces must work keyboard-only).

const RING_LABELS = {
  apis: "APIs & consumers",
  services: "Services",
  schemas: "Schemas",
  tests: "Tests",
  docs: "Docs",
  dependencies: "Dependencies",
};

const STATUS_GLYPH = {
  changed: "✦", // ✦
  affected: "●", // ●
  potentially_affected: "!",
  risk: "✕", // ✕
  verified: "✓", // ✓
};

const STATUS_LABEL = {
  changed: "Changed",
  affected: "Affected",
  potentially_affected: "May be affected",
  risk: "Needs attention",
  verified: "Verified",
};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function makeNode({ x, y, radius, statusClass, label, statusKey, file, onActivate, delay = 0 }) {
  const g = svgEl("g", {
    class: `radar-node ${statusClass}`,
    transform: `translate(${x},${y})`,
    tabindex: "0",
    role: "button",
    "aria-label": `${label}: ${STATUS_LABEL[statusKey] || statusKey}`,
    "data-file": file || "",
    style: `animation-delay: ${delay}ms`,
  });
  const title = svgEl("title");
  title.textContent = `${label} — ${STATUS_LABEL[statusKey] || statusKey}`;
  g.appendChild(title);
  // Comfortable hit area covering the node and its label.
  const hitW = Math.max(radius * 2 + 16, label.length * 6.4 + 12);
  g.appendChild(svgEl("rect", { class: "hit", x: -hitW / 2, y: -radius - 8, width: hitW, height: radius * 2 + 30, rx: 8 }));
  g.appendChild(svgEl("circle", { r: radius }));
  const glyph = STATUS_GLYPH[statusKey];
  if (statusKey === "affected") {
    g.appendChild(svgEl("circle", { r: Math.max(radius / 3, 2), class: "dot" }));
  } else if (glyph) {
    g.appendChild(svgEl("text", { class: "glyph", "font-size": radius, dy: "0.5" })).textContent = glyph;
  }
  const t = svgEl("text", { y: radius + 13, "text-anchor": "middle" });
  t.textContent = label;
  g.appendChild(t);

  g.addEventListener("click", onActivate);
  g.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  });
  return g;
}

function renderRadar(container, radar, onNodeClick) {
  container.innerHTML = "";
  const rings = radar.rings && radar.rings.length ? radar.rings : ["apis", "services", "schemas", "tests", "docs", "dependencies"];
  const ringGap = 46;
  const baseRadius = 64;
  // Canvas must comfortably fit the outermost ring plus node radius and
  // its label text underneath it, or outer-ring nodes (docs/dependencies)
  // silently clip off the edge of the SVG.
  const outerRadius = baseRadius + (rings.length - 1) * ringGap;
  const size = (outerRadius + 56) * 2;
  const cx = size / 2;
  const cy = size / 2;

  const svg = svgEl("svg", {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    role: "img",
    "aria-label": `Blast radius: ${radar.center.length} changed ${radar.center.length === 1 ? "file" : "files"} reaching ${radar.nodes.length} related ${radar.nodes.length === 1 ? "file" : "files"}.`,
  });

  rings.forEach((ring, i) => {
    const r = baseRadius + i * ringGap;
    svg.appendChild(svgEl("circle", { cx, cy, r, class: "radar-ring-line" }));
    const label = svgEl("text", { x: cx, y: cy - r - 4, class: "radar-ring-label", "text-anchor": "middle" });
    label.textContent = RING_LABELS[ring] || ring;
    svg.appendChild(label);
  });

  const byRing = {};
  for (const n of radar.nodes) {
    byRing[n.ring] = byRing[n.ring] || [];
    byRing[n.ring].push(n);
  }

  const edgeLayer = svgEl("g");
  const nodeLayer = svgEl("g");
  svg.appendChild(edgeLayer);

  const centerNodes = radar.center || [];
  const centerPositions = [];
  centerNodes.forEach((c, i) => {
    const angle = (i / Math.max(centerNodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const rr = centerNodes.length > 1 ? 22 : 0;
    const x = cx + rr * Math.cos(angle);
    const y = cy + rr * Math.sin(angle);
    centerPositions.push({ x, y });
    const node = makeNode({
      x,
      y,
      radius: 15,
      statusClass: "changed",
      statusKey: "changed",
      label: c.label,
      file: c.file,
      delay: i * 60,
      onActivate: () => onNodeClick({ kind: "changed", file: c.file }),
    });
    node.insertBefore(svgEl("circle", { r: 20, class: "radar-node-halo" }), node.querySelector("circle"));
    nodeLayer.appendChild(node);
  });
  const anchor = centerPositions[0] || { x: cx, y: cy };

  rings.forEach((ring, ringIdx) => {
    const nodes = byRing[ring] || [];
    const r = baseRadius + ringIdx * ringGap;
    const count = nodes.length;
    nodes.forEach((n, i) => {
      const angle = (i / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2 + ringIdx * 0.35;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      const nodeDelay = 200 + ringIdx * 120 + i * 40;
      edgeLayer.appendChild(svgEl("line", { x1: anchor.x, y1: anchor.y, x2: x, y2: y, class: "radar-edge", style: `animation-delay: ${nodeDelay - 150}ms` }));

      const radius = n.status === "risk" ? 10 : 8;
      const node = makeNode({
        x,
        y,
        radius,
        statusClass: n.status,
        statusKey: n.status,
        label: n.label,
        file: n.file,
        delay: nodeDelay,
        onActivate: () => onNodeClick({ kind: "context", node: n }),
      });
      nodeLayer.appendChild(node);
    });
  });

  svg.appendChild(nodeLayer);
  container.appendChild(svg);
}

window.DiffLensRadar = { renderRadar, STATUS_GLYPH, STATUS_LABEL };
