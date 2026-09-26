// Repo-loading for the static build: three ways in, all ending at the same
// place -- a LightningFS instance with the repo's files (including .git)
// written into it, ready for browserGit.js/isomorphic-git to read.

import { newFs, cloneRepo, isLikelyGitRepo } from "./browserGit.js";

async function mkdirp(fs, dir) {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += `/${part}`;
    try {
      await fs.promises.mkdir(cur);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

async function writeFileDeep(fs, dir, relPath, data) {
  const full = `${dir}/${relPath}`;
  const parentDir = full.slice(0, full.lastIndexOf("/"));
  await mkdirp(fs, parentDir);
  await fs.promises.writeFile(full, data);
}

/**
 * Loads from a real FileSystemDirectoryHandle (Chromium's showDirectoryPicker).
 * Returns a dirHandle in the result so patches can later be written back to
 * the user's real disk, not just the in-browser copy.
 */
export async function loadFromDirectoryHandle(dirHandle) {
  const fs = newFs();
  const dir = "/repo";
  await fs.promises.mkdir(dir);

  async function walk(handle, relPath) {
    for await (const [name, entry] of handle.entries()) {
      const childRel = relPath ? `${relPath}/${name}` : name;
      if (entry.kind === "directory") {
        await walk(entry, childRel);
      } else {
        const file = await entry.getFile();
        const buf = new Uint8Array(await file.arrayBuffer());
        await writeFileDeep(fs, dir, childRel, buf);
      }
    }
  }
  await walk(dirHandle, "");

  const valid = await isLikelyGitRepo(fs, dir);
  return { fs, dir, name: dirHandle.name, dirHandle, valid, writable: true };
}

/**
 * Fallback loader for browsers without showDirectoryPicker (Firefox,
 * Safari): a FileList from <input webkitdirectory>. Read-only -- there's
 * no way to write back to the original folder from here, so Fix Mode
 * offers a download instead.
 */
export async function loadFromFileList(fileList) {
  const fs = newFs();
  const dir = "/repo";
  await fs.promises.mkdir(dir);

  const files = Array.from(fileList);
  let rootName = "repo";
  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/");
    if (parts.length > 1) rootName = parts[0];
    const withoutRoot = parts.slice(1).join("/") || parts[0];
    const buf = new Uint8Array(await file.arrayBuffer());
    await writeFileDeep(fs, dir, withoutRoot, buf);
  }

  const valid = await isLikelyGitRepo(fs, dir);
  return { fs, dir, name: rootName, dirHandle: null, valid, writable: false };
}

/** Loads from an uploaded .zip (fflate, static/vendor/fflate.js). */
export async function loadFromZip(arrayBuffer, displayName) {
  const fflate = await import("../vendor/fflate.js");
  const fs = newFs();
  const dir = "/repo";
  await fs.promises.mkdir(dir);

  const entries = fflate.unzipSync(new Uint8Array(arrayBuffer));
  const paths = Object.keys(entries);

  // If everything lives under one common top-level folder (the usual
  // "repo-name/" wrapper from a zip export), strip it so dir === repo root.
  const topLevel = new Set(paths.map((p) => p.split("/")[0]).filter(Boolean));
  const stripPrefix = topLevel.size === 1 ? `${[...topLevel][0]}/` : "";

  for (const [entryPath, data] of Object.entries(entries)) {
    if (entryPath.endsWith("/")) continue; // directory marker
    const relPath = stripPrefix && entryPath.startsWith(stripPrefix) ? entryPath.slice(stripPrefix.length) : entryPath;
    if (!relPath) continue;
    await writeFileDeep(fs, dir, relPath, data);
  }

  const valid = await isLikelyGitRepo(fs, dir);
  const name = (stripPrefix || displayName || "repo").replace(/\/$/, "").replace(/\.zip$/i, "");
  return { fs, dir, name, dirHandle: null, valid, writable: false };
}

/**
 * Clones a public repo directly into the browser via isomorphic-git's
 * documented CORS-proxy pattern (GitHub's git-over-HTTP endpoints don't
 * send CORS headers themselves, so a plain browser fetch to them is
 * blocked regardless of this being a static page or not -- the proxy is
 * what makes browser-side git cloning of GitHub repos possible at all).
 */
export async function loadFromGithubUrl(url) {
  const fs = newFs();
  const dir = "/repo";
  await fs.promises.mkdir(dir);
  await cloneRepo(url, fs, dir);
  const name = url.replace(/\.git$/i, "").split("/").filter(Boolean).pop() || "repo";
  const valid = await isLikelyGitRepo(fs, dir);
  return { fs, dir, name, dirHandle: null, valid, writable: false };
}
