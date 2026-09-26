import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

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

export function hashContent(content) {
  return crypto.createHash("sha256").update(content ?? "").digest("hex");
}

/** Resolve a repo-relative path and guarantee it stays inside repoPath. */
export function safeResolve(repoPath, relPath) {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
    throw new PatchValidationError(`Refusing unsafe path: ${relPath}`);
  }
  const root = path.resolve(repoPath) + path.sep;
  const resolved = path.resolve(repoPath, relPath);
  if (!resolved.startsWith(root)) {
    throw new PatchValidationError(`Path escapes repository root: ${relPath}`);
  }
  return resolved;
}

export function isSecretPath(relPath) {
  return SECRET_PATH_PATTERNS.some((re) => re.test(relPath));
}

export class PatchValidationError extends Error {}

/**
 * Validate a patch before it is ever written to disk:
 *  - every target path must resolve inside the repo (no traversal)
 *  - no target may match a secret/credential file pattern
 *  - every target file's current content hash must match the hash taken
 *    at analysis time (snapshotHashes); otherwise the file changed under
 *    us and the patch is stale and must be regenerated from fresh analysis
 */
export function validatePatch({ repoPath, patch, snapshotHashes }) {
  if (!patch.targetFiles || patch.targetFiles.length === 0) {
    throw new PatchValidationError("Patch has no target files.");
  }

  for (const relPath of patch.targetFiles) {
    const abs = safeResolve(repoPath, relPath);
    if (isSecretPath(relPath)) {
      throw new PatchValidationError(`Refusing to patch a credential/secret-like path: ${relPath}`);
    }
    const expectedHash = snapshotHashes?.[relPath];
    if (!expectedHash) {
      throw new PatchValidationError(`No analysis snapshot for ${relPath}; re-run analysis before generating a patch.`);
    }
    let currentContent = "";
    if (fs.existsSync(abs)) {
      currentContent = fs.readFileSync(abs, "utf8");
    }
    const currentHash = hashContent(currentContent);
    if (currentHash !== expectedHash) {
      throw new PatchValidationError(
        `${relPath} changed on disk since analysis ran. Patch is stale; re-analyze before applying.`
      );
    }
  }

  for (const op of patch.operations || []) {
    safeResolve(repoPath, op.file);
    if (isSecretPath(op.file)) {
      throw new PatchValidationError(`Refusing to patch a credential/secret-like path: ${op.file}`);
    }
  }

  return true;
}
