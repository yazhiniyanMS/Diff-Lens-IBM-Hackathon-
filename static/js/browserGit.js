// Browser replacement for server/lib/git.js. Same conceptual surface
// (branches, refs, diffs, blob reads) but backed by isomorphic-git +
// LightningFS (static/vendor/git-bundle.js) instead of the real git CLI --
// this is what lets the whole pipeline run with zero server. See
// docs/static-build.md for the architecture and its trade-offs.

import "../vendor/git-bundle.js"; // side-effect: sets window.DiffLensGitVendor

const { git, http, LightningFS } = window.DiffLensGitVendor;

export const REF = { WORKING_TREE: "WORKING", STAGED: "STAGED" };

const CORS_PROXY = "https://cors.isomorphic-git.org";

let fsCounter = 0;

/** Creates a fresh, isolated in-browser filesystem for one loaded repo. */
export function newFs() {
  fsCounter += 1;
  return new LightningFS(`difflens-${Date.now()}-${fsCounter}`);
}

export async function assertGitRepo(fs, dir) {
  try {
    await fs.promises.stat(`${dir}/.git`);
  } catch {
    throw new Error(`Not a git repository: no .git found under ${dir}`);
  }
}

export async function isLikelyGitRepo(fs, dir) {
  try {
    await assertGitRepo(fs, dir);
    return true;
  } catch {
    return false;
  }
}

export async function listBranches(fs, dir) {
  return git.listBranches({ fs, dir });
}

export async function getCurrentRef(fs, dir) {
  const branch = await git.currentBranch({ fs, dir, fullname: false });
  if (branch) return branch;
  const oid = await git.resolveRef({ fs, dir, ref: "HEAD" });
  return oid.slice(0, 7);
}

async function resolveOid(fs, dir, ref) {
  return git.resolveRef({ fs, dir, ref });
}

export async function commitMeta(fs, dir, ref) {
  if (ref === REF.WORKING_TREE || ref === REF.STAGED) {
    return { ref, subject: ref === REF.STAGED ? "Staged changes" : "Working tree", author: null, date: null };
  }
  const [entry] = await git.log({ fs, dir, ref, depth: 1 });
  return {
    ref: entry.oid,
    author: entry.commit.author.name,
    date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
    subject: entry.commit.message.split("\n")[0],
  };
}

/** All tracked file paths at a ref (or the live working tree). */
export async function listTrackedFiles(fs, dir, ref) {
  if (ref === REF.WORKING_TREE || ref === REF.STAGED) {
    // Best available proxy for "tracked files" without a real index walk:
    // list HEAD's tree. Good enough for ranking context candidates.
    return git.listFiles({ fs, dir, ref: "HEAD" });
  }
  return git.listFiles({ fs, dir, ref });
}

export async function readFileAtRef(fs, dir, ref, filepath) {
  if (ref === REF.WORKING_TREE) {
    try {
      const data = await fs.promises.readFile(`${dir}/${filepath}`);
      return bufToUtf8(data);
    } catch {
      return null;
    }
  }
  try {
    const oid = await resolveOid(fs, dir, ref);
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return bufToUtf8(blob);
  } catch {
    return null;
  }
}

function bufToUtf8(buf) {
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Walks base..head (head may be WORKING_TREE) and returns per-file change
 * records: {path, oldPath, status, oldContent, newContent, isBinary}.
 * This single tree walk is the shared source of truth for both the
 * unified-diff text (below) and the deterministic change-signal
 * extraction in browserContextEngine.js, so a repo is only walked once.
 */
export async function computeChanges(fs, dir, base, head) {
  const baseOid = await resolveOid(fs, dir, base);
  const trees = [git.TREE({ ref: baseOid })];
  const useWorkdir = head === REF.WORKING_TREE || head === REF.STAGED;
  if (useWorkdir) {
    trees.push(git.WORKDIR());
  } else {
    const headOid = await resolveOid(fs, dir, head);
    trees.push(git.TREE({ ref: headOid }));
  }

  const results = await git.walk({
    fs,
    dir,
    trees,
    map: async (filepath, [baseEntry, headEntry]) => {
      // IMPORTANT: isomorphic-git's walk() treats a `null` return as "prune
      // this subtree, stop recursing" -- only .git itself should ever do
      // that. Every other "not a result" case must return `undefined`
      // (via a bare `return`), or the walk stops dead at that entry
      // instead of continuing into its children.
      if (filepath === ".") return;
      if (filepath.startsWith(".git/") || filepath === ".git") return null;
      const baseType = baseEntry ? await baseEntry.type() : null;
      const headType = headEntry ? await headEntry.type() : null;
      if (baseType === "tree" || headType === "tree") return; // directories: keep recursing
      if (!baseEntry && !headEntry) return;

      const baseOidEntry = baseEntry ? await baseEntry.oid() : null;
      const headOidEntry = headEntry ? await headEntry.oid() : null;
      if (baseOidEntry && headOidEntry && baseOidEntry === headOidEntry) return; // unchanged

      let status = "modified";
      if (!baseEntry) status = "added";
      else if (!headEntry) status = "deleted";

      const oldContentBuf = baseEntry ? await baseEntry.content() : null;
      const newContentBuf = headEntry ? await headEntry.content() : null;
      const isBinary = (oldContentBuf && isBinaryBuffer(oldContentBuf)) || (newContentBuf && isBinaryBuffer(newContentBuf));

      return {
        path: filepath,
        status,
        isBinary: !!isBinary,
        oldContent: oldContentBuf && !isBinary ? bufToUtf8(oldContentBuf) : null,
        newContent: newContentBuf && !isBinary ? bufToUtf8(newContentBuf) : null,
      };
    },
  });

  return results.filter(Boolean);
}

/**
 * Produces a standard unified-diff string from computeChanges() output,
 * using jsdiff for the hunk text (static/vendor/diff.js, loaded as a
 * classic script that sets window.Diff) and synthesizing the same
 * "diff --git a/x b/x" / "new file mode" / "Binary files ... differ"
 * header lines `server/lib/diffParser.js` already knows how to parse --
 * so that module is reused completely unchanged for the browser build.
 */
export function buildUnifiedDiff(changes) {
  const Diff = window.Diff;
  const parts = [];
  for (const c of changes) {
    parts.push(`diff --git a/${c.path} b/${c.path}`);
    if (c.status === "added") parts.push("new file mode 100644");
    if (c.status === "deleted") parts.push("deleted file mode 100644");
    if (c.isBinary) {
      parts.push(`Binary files a/${c.path} and b/${c.path} differ`);
      continue;
    }
    const patch = Diff.createTwoFilesPatch(
      c.path,
      c.path,
      c.oldContent ?? "",
      c.newContent ?? "",
      "",
      "",
      { context: 3 }
    );
    // Drop jsdiff's own "Index:"/"===" and "---"/"+++" header lines; we
    // already emitted the diff --git header, and diffParser.js only needs
    // the @@ hunks and +/- lines that follow.
    const lines = patch.split("\n");
    const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
    if (hunkStart === -1) continue;
    parts.push(`--- a/${c.path}`, `+++ b/${c.path}`, ...lines.slice(hunkStart));
  }
  return parts.join("\n") + (parts.length ? "\n" : "");
}

export async function getDiff(fs, dir, base, head) {
  const changes = await computeChanges(fs, dir, base, head);
  return buildUnifiedDiff(changes);
}

/** Clone a public repo directly into the browser via a CORS proxy (see
 * docs/static-build.md) -- no server involved at all. */
export async function cloneRepo(url, fs, dir, { depth = 100 } = {}) {
  await git.clone({ fs, http, dir, url, corsProxy: CORS_PROXY, depth, singleBranch: false });
}

export { git, http, LightningFS };
