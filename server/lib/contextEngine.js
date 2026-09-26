import path from "node:path";
import { listTrackedFiles, readFileAtRef, REF } from "./git.js";
import { extractSymbols, extLang } from "./symbolExtractor.js";

const IGNORE_DIR_RE = /(^|\/)(\.git|node_modules|dist|build|coverage|\.next|\.cache|venv|__pycache__)(\/|$)/;
const MAX_FILE_BYTES = 400_000;
const CONTEXT_BUDGET = 25;

function isIgnorable(filePath) {
  return IGNORE_DIR_RE.test(filePath);
}

function diffFieldSets(oldSymbols, newSymbols) {
  const oldFields = new Set(oldSymbols?.fields || []);
  const newFields = new Set(newSymbols?.fields || []);
  const removed = [...oldFields].filter((f) => !newFields.has(f));
  const added = [...newFields].filter((f) => !oldFields.has(f));
  return { removed, added };
}

/**
 * Build the set of "terms of interest" from the parsed diff: field names
 * that were removed/added, function/class/route names touched, and the
 * basenames of changed files (for import-reference matching).
 */
export async function extractChangeSignals(repoPath, base, head, parsedFiles) {
  const signals = {
    changedFiles: [],
    removedFields: new Set(),
    addedFields: new Set(),
    addedFunctionNames: new Set(),
    removedFunctionNames: new Set(),
    touchedSymbolNames: new Set(),
    touchedRoutes: [],
  };

  for (const file of parsedFiles) {
    if (file.isBinary) continue;
    const newPath = file.newPath;
    signals.changedFiles.push(newPath);

    const [oldContent, newContent] = await Promise.all([
      readFileAtRef(repoPath, base, file.oldPath),
      readFileAtRef(repoPath, head, newPath),
    ]);
    const oldSymbols = extractSymbols(file.oldPath, oldContent);
    const newSymbols = extractSymbols(newPath, newContent);

    const { removed, added } = diffFieldSets(oldSymbols, newSymbols);
    removed.forEach((f) => signals.removedFields.add(f));
    added.forEach((f) => signals.addedFields.add(f));

    const oldFnNames = new Set((oldSymbols.functions || []).map((f) => f.name));
    const newFnNames = new Set((newSymbols.functions || []).map((f) => f.name));
    for (const name of newFnNames) {
      if (!oldFnNames.has(name)) signals.addedFunctionNames.add(name);
    }
    for (const name of oldFnNames) {
      if (!newFnNames.has(name)) signals.removedFunctionNames.add(name);
    }

    for (const fn of [...(newSymbols.functions || []), ...(oldSymbols.functions || [])]) {
      signals.touchedSymbolNames.add(fn.name);
    }
    for (const route of [...(newSymbols.routes || []), ...(oldSymbols.routes || [])]) {
      signals.touchedRoutes.push(route);
    }
  }

  const seenRoutes = new Set();
  signals.touchedRoutes = signals.touchedRoutes.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seenRoutes.has(key)) return false;
    seenRoutes.add(key);
    return true;
  });

  return signals;
}

function classifyRelationship(filePath, matchedTerms) {
  const lower = filePath.toLowerCase();
  if (/test|spec|__tests__/.test(lower)) return { type: "test", ring: "tests" };
  if (/\.md$|docs\//.test(lower)) return { type: "documentation", ring: "docs" };
  if (/schema|model/.test(lower)) return { type: "schema", ring: "schemas" };
  if (/frontend|client|ui|components|pages/.test(lower)) return { type: "api_consumer", ring: "apis" };
  if (/route|controller|service|api/.test(lower)) return { type: "service", ring: "services" };
  if (/package\.json|requirements\.txt|go\.mod|cargo\.toml/.test(lower)) return { type: "dependency", ring: "dependencies" };
  return { type: "reference", ring: "services" };
}

/**
 * Practical, ranked context retrieval: scan tracked repository files for
 * references to the "signals" derived from the diff (removed/added field
 * names, touched function/route names, changed file basenames). This is
 * not a compiler-accurate dependency graph -- it is evidence-backed textual
 * and structural relevance ranking, budgeted to stay small.
 */
export async function gatherContext(repoPath, head, signals, changedFileSet) {
  const allFiles = await listTrackedFiles(repoPath);
  const candidates = allFiles.filter((f) => !isIgnorable(f) && !changedFileSet.has(f));

  const changedBasenames = [...changedFileSet].map((f) => path.basename(f, path.extname(f)));
  const terms = [
    ...[...signals.removedFields].map((t) => ({ term: t, kind: "removed_field", weight: 5 })),
    ...[...signals.addedFields].map((t) => ({ term: t, kind: "added_field", weight: 3 })),
    ...[...signals.touchedSymbolNames].map((t) => ({ term: t, kind: "symbol", weight: 4 })),
    ...signals.touchedRoutes.map((r) => ({ term: r.path, kind: "route", weight: 4 })),
    ...changedBasenames.map((t) => ({ term: t, kind: "import", weight: 2 })),
  ].filter((t) => t.term && t.term.length > 1);

  const results = [];

  for (const file of candidates) {
    if (extLang(file) === "other" && !/\.(md|json|ya?ml)$/.test(file)) continue;
    let content;
    try {
      content = await readFileAtRef(repoPath, head, file);
    } catch {
      continue;
    }
    if (!content || content.length > MAX_FILE_BYTES) continue;

    const matches = [];
    for (const t of terms) {
      const re = new RegExp(`\\b${escapeRegex(t.term)}\\b`, "g");
      let m;
      let count = 0;
      const lineHits = [];
      while ((m = re.exec(content)) && count < 5) {
        const lineNo = content.slice(0, m.index).split("\n").length;
        lineHits.push(lineNo);
        count++;
      }
      if (count > 0) {
        matches.push({ term: t.term, kind: t.kind, weight: t.weight, count, lines: lineHits });
      }
    }
    if (matches.length === 0) continue;

    const score = matches.reduce((sum, m) => sum + m.weight * Math.min(m.count, 3), 0);
    const { type, ring } = classifyRelationship(file, matches);

    results.push({
      file,
      relationshipType: type,
      ring,
      score,
      matches,
      lines: dedupeLines(matches),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, CONTEXT_BUDGET);
}

function dedupeLines(matches) {
  const set = new Set();
  matches.forEach((m) => m.lines.forEach((l) => set.add(l)));
  return Array.from(set).sort((a, b) => a - b).slice(0, 8);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
