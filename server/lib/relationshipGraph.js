/**
 * Builds the data structure that drives the Review Radar UI: a center ring
 * of changed files and surrounding rings of related nodes (apis, services,
 * schemas, tests, docs, dependencies), each carrying a status derived from
 * real analysis (not decorative). Status is assigned deterministically from
 * context matches; "missing" nodes are ones the risk model has flagged.
 */

const RINGS = ["apis", "services", "schemas", "tests", "docs", "dependencies"];

export function buildRadarGraph({ changedFiles, contextItems, findings }) {
  const center = changedFiles.map((f) => ({
    id: `changed:${f}`,
    file: f,
    label: shortLabel(f),
    kind: "changed",
  }));

  const findingsByFile = new Map();
  for (const finding of findings) {
    for (const ev of finding.evidence || []) {
      if (!ev.file) continue;
      if (!findingsByFile.has(ev.file)) findingsByFile.set(ev.file, []);
      findingsByFile.get(ev.file).push(finding);
    }
  }

  const nodes = [];
  for (const item of contextItems) {
    const ring = RINGS.includes(item.ring) ? item.ring : "services";
    const relatedFindings = findingsByFile.get(item.file) || [];
    const status = deriveStatus(item, relatedFindings);
    nodes.push({
      id: `ctx:${item.file}`,
      file: item.file,
      ring,
      label: shortLabel(item.file),
      relationshipType: item.relationshipType,
      score: item.score,
      status,
      matches: item.matches,
      findingIds: relatedFindings.map((f) => f.id),
    });
  }

  // Untouched-but-relevant nodes get surfaced with elevated visual weight
  // when a finding explicitly names them (e.g. "suspiciously untouched").
  for (const finding of findings) {
    for (const ev of finding.evidence || []) {
      if (!ev.file) continue;
      if (!nodes.find((n) => n.file === ev.file) && !changedFiles.includes(ev.file)) {
        nodes.push({
          id: `ctx:${ev.file}`,
          file: ev.file,
          ring: ringForFinding(finding),
          label: shortLabel(ev.file),
          relationshipType: "flagged",
          score: 0,
          status: statusForRisk(finding.risk),
          matches: [],
          findingIds: [finding.id],
        });
      }
    }
  }

  const edges = nodes.map((n) => ({ from: n.id, to: pickCenterAnchor(center) }));

  return { center, rings: RINGS, nodes, edges };
}

function pickCenterAnchor(center) {
  return center[0]?.id || "changed:unknown";
}

function ringForFinding(finding) {
  const category = (finding.category || "").toLowerCase();
  if (category.includes("test")) return "tests";
  if (category.includes("doc")) return "docs";
  if (category.includes("schema") || category.includes("contract") || category.includes("api")) return "apis";
  if (category.includes("dependency")) return "dependencies";
  return "services";
}

function statusForRisk(risk) {
  if (risk === "high") return "risk";
  if (risk === "medium") return "potentially_affected";
  return "affected";
}

function deriveStatus(item, relatedFindings) {
  if (relatedFindings.some((f) => f.risk === "high")) return "risk";
  if (relatedFindings.some((f) => f.risk === "medium")) return "potentially_affected";
  if (relatedFindings.length > 0) return "affected";
  if (item.score >= 8) return "affected";
  return "potentially_affected";
}

function shortLabel(filePath) {
  const parts = filePath.split("/");
  return parts.slice(-2).join("/");
}
