import fs from "node:fs";
import { safeResolve, hashContent, validatePatch, PatchValidationError } from "./validator.js";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyOperation(content, op) {
  if (op.kind === "replace_all") {
    const re = new RegExp(`\\b${escapeRegex(op.find)}\\b`, "g");
    return content.replace(re, op.replace);
  }
  if (op.kind === "insert_after_match") {
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.includes(op.match));
    if (idx === -1) return content; // anchor not found; no-op rather than corrupt the file
    const indentMatch = lines[idx].match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    const insertLine = op.insertText.trimStart().length ? indent + op.insertText.trim() : op.insertText;
    lines.splice(idx + 1, 0, insertLine);
    return lines.join("\n");
  }
  throw new PatchValidationError(`Unknown patch operation kind: ${op.kind}`);
}

/**
 * Apply a validated, approved patch to the working tree. Never called
 * without a prior validatePatch() pass. Re-validates staleness itself as a
 * defense-in-depth measure (the caller may have raced between preview and
 * approval).
 */
export function applyPatch({ repoPath, patch, snapshotHashes }) {
  validatePatch({ repoPath, patch, snapshotHashes });

  const touched = {};
  const byFile = new Map();
  for (const op of patch.operations || []) {
    if (!byFile.has(op.file)) byFile.set(op.file, []);
    byFile.get(op.file).push(op);
  }

  for (const [relPath, ops] of byFile) {
    const abs = safeResolve(repoPath, relPath);
    let content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const before = content;
    for (const op of ops) {
      content = applyOperation(content, op);
    }
    if (content !== before) {
      fs.writeFileSync(abs, content);
      touched[relPath] = { before: hashContent(before), after: hashContent(content) };
    }
  }

  return {
    appliedAt: new Date().toISOString(),
    findingId: patch.findingId,
    touchedFiles: Object.keys(touched),
    hashes: touched,
  };
}
