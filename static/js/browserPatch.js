// Browser port of server/lib/patch/validator.js + apply.js. Same safety
// rules (path traversal, secret-file denylist, staleness-by-hash); the
// only real difference is *where* files live: LightningFS instead of a
// real filesystem, plus an optional real FileSystemDirectoryHandle (when
// the repo was loaded via the Chromium folder picker) that gets written
// back to as well, so "Apply" can actually update the user's real files
// when the browser allows it.

export class PatchValidationError extends Error {}

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git\//,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials\.json$/i,
  /secrets?\.ya?ml$/i,
  /\.npmrc$/i,
  /\.aws\//,
];

export function isSecretPath(relPath) {
  return SECRET_PATH_PATTERNS.some((re) => re.test(relPath));
}

export function safeRelPath(relPath) {
  if (!relPath || relPath.startsWith("/") || relPath.split("/").includes("..")) {
    throw new PatchValidationError(`Refusing unsafe path: ${relPath}`);
  }
  return relPath;
}

export async function hashContent(content) {
  const bytes = new TextEncoder().encode(content ?? "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validatePatch({ fs, dir, patch, snapshotHashes }) {
  if (!patch.targetFiles || patch.targetFiles.length === 0) {
    throw new PatchValidationError("Patch has no target files.");
  }
  for (const relPath of patch.targetFiles) {
    safeRelPath(relPath);
    if (isSecretPath(relPath)) {
      throw new PatchValidationError(`Refusing to patch a credential/secret-like path: ${relPath}`);
    }
    const expectedHash = snapshotHashes?.[relPath];
    if (!expectedHash) {
      throw new PatchValidationError(`No analysis snapshot for ${relPath}; re-run analysis before generating a patch.`);
    }
    let currentContent = "";
    try {
      currentContent = new TextDecoder().decode(await fs.promises.readFile(`${dir}/${relPath}`));
    } catch {
      // file doesn't exist -- hashContent("") below will simply mismatch
      // a non-empty snapshot, which is the correct "stale" outcome.
    }
    const currentHash = await hashContent(currentContent);
    if (currentHash !== expectedHash) {
      throw new PatchValidationError(`${relPath} changed since analysis ran. Patch is stale; re-analyze before applying.`);
    }
  }
  for (const op of patch.operations || []) {
    safeRelPath(op.file);
    if (isSecretPath(op.file)) {
      throw new PatchValidationError(`Refusing to patch a credential/secret-like path: ${op.file}`);
    }
  }
  return true;
}

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
    if (idx === -1) return content;
    const indentMatch = lines[idx].match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    const insertLine = op.insertText.trimStart().length ? indent + op.insertText.trim() : op.insertText;
    lines.splice(idx + 1, 0, insertLine);
    return lines.join("\n");
  }
  throw new PatchValidationError(`Unknown patch operation kind: ${op.kind}`);
}

/** Walk/create directory handles for a relative path and write the file --
 * this is what lets "Apply" reach the user's real disk when they loaded
 * the repo via the Chromium folder picker (a real FileSystemDirectoryHandle
 * with write permission), instead of only updating the in-browser copy. */
async function writeToRealHandle(rootHandle, relPath, content) {
  const parts = relPath.split("/");
  const fileName = parts.pop();
  let dirHandle = rootHandle;
  for (const part of parts) {
    dirHandle = await dirHandle.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Apply a validated patch. Always updates the in-browser LightningFS copy;
 * additionally writes back to `dirHandle` (a real, permitted
 * FileSystemDirectoryHandle) when one is available.
 */
export async function applyPatch({ fs, dir, patch, snapshotHashes, dirHandle }) {
  await validatePatch({ fs, dir, patch, snapshotHashes });

  const touched = {};
  const byFile = new Map();
  for (const op of patch.operations || []) {
    if (!byFile.has(op.file)) byFile.set(op.file, []);
    byFile.get(op.file).push(op);
  }

  for (const [relPath, ops] of byFile) {
    let content = "";
    try {
      content = new TextDecoder().decode(await fs.promises.readFile(`${dir}/${relPath}`));
    } catch {
      // new file via patch ops -- start from empty content
    }
    const before = content;
    for (const op of ops) content = applyOperation(content, op);
    if (content !== before) {
      await fs.promises.writeFile(`${dir}/${relPath}`, content, "utf8");
      let wroteToDisk = false;
      if (dirHandle) {
        try {
          await writeToRealHandle(dirHandle, relPath, content);
          wroteToDisk = true;
        } catch (err) {
          console.warn(`Could not write ${relPath} back to disk (permission?): ${err.message}`);
        }
      }
      touched[relPath] = { before: await hashContent(before), after: await hashContent(content), content, wroteToDisk };
    }
  }

  return {
    appliedAt: new Date().toISOString(),
    findingId: patch.findingId,
    touchedFiles: Object.keys(touched),
    wroteToDisk: dirHandle ? Object.values(touched).some((t) => t.wroteToDisk) : false,
    details: touched,
  };
}
