import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";

function uploadsRoot() {
  const dir = path.join(process.env.DIFFLENS_DATA_DIR || path.join(process.cwd(), ".difflens"), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Allocate a fresh, empty directory to receive one upload's contents. */
export function newUploadDir() {
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(uploadsRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assertSafeRelativePath(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Refusing unsafe upload path: ${relPath}`);
  }
  return normalized;
}

/**
 * Write a browser directory-picker upload (a flat list of files, each with
 * its original relative path) into destDir, preserving structure. Browsers
 * (Chromium-based, verified) include dotfiles/dotdirs in a webkitdirectory
 * selection, so a real .git directory comes through intact.
 */
export function writeUploadedFiles(destDir, files, relativePaths) {
  if (files.length !== relativePaths.length) {
    throw new Error("Mismatched file/path counts in upload.");
  }
  for (let i = 0; i < files.length; i++) {
    const rel = assertSafeRelativePath(relativePaths[i]);
    const target = path.join(destDir, rel);
    if (!target.startsWith(path.resolve(destDir) + path.sep)) {
      throw new Error(`Refusing upload path that escapes the destination: ${rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[i].buffer);
  }
}

/** Extract a .zip buffer into destDir, guarding against zip-slip. */
export function extractZip(destDir, zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const destRoot = path.resolve(destDir) + path.sep;
  for (const entry of zip.getEntries()) {
    const rel = assertSafeRelativePath(entry.entryName);
    const target = path.join(destDir, rel);
    if (!target.startsWith(destRoot)) {
      throw new Error(`Refusing zip entry that escapes the destination: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  }
}

/**
 * If the uploaded tree has exactly one top-level entry that is itself a
 * directory (the common "repo-name/" wrapper folder from a folder picker or
 * a zip export), return that inner path as the effective repo root instead
 * -- otherwise a .git one level down would never be found.
 */
export function resolveEffectiveRoot(dir) {
  const entries = fs.readdirSync(dir);
  if (entries.length === 1) {
    const only = path.join(dir, entries[0]);
    if (fs.statSync(only).isDirectory()) return only;
  }
  return dir;
}
