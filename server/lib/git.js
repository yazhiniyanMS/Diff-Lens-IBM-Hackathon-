import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const WORKING_TREE = "WORKING";
const STAGED = "STAGED";

/**
 * Thin, safe wrapper around the `git` CLI. Every call is pinned to a
 * specific repository directory (cwd) and uses execFile (no shell), so
 * arguments can never be interpreted as shell metacharacters.
 */
async function run(repoPath, args, options = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 64,
      timeout: options.timeout || 20_000,
    });
    return stdout;
  } catch (err) {
    const message = err.stderr || err.message || String(err);
    const wrapped = new Error(`git ${args.join(" ")} failed: ${message.trim()}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

const CLONE_TIMEOUT_MS = 60_000;

/** Only plain http(s) URLs are accepted -- see validateCloneUrl for why. */
export function validateCloneUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http:// and https:// git URLs are supported (no ssh://, git://, or file://).");
  }
  return parsed.toString();
}

/**
 * Clone a remote repository (public, unauthenticated) into destDir.
 * Restricted to http(s) URLs and run with execFile (no shell), so the URL
 * can never be interpreted as a shell command or a local file path.
 * Fetches all branches with limited history depth, which is enough to diff
 * any two branches/commits within that window without downloading the
 * entire history of a large repository.
 */
export async function cloneRepo(rawUrl, destDir, { depth = 100 } = {}) {
  const url = validateCloneUrl(rawUrl);
  try {
    await execFileAsync("git", ["clone", "--depth", String(depth), "--no-single-branch", "--", url, destDir], {
      maxBuffer: 1024 * 1024 * 64,
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (err) {
    const stderr = (err.stderr || "").trim();
    if (/could not read username|terminal prompts disabled|authentication failed/i.test(stderr)) {
      throw new Error("Could not clone: repository not found, or it's private (only public repos are supported).");
    }
    if (/timed? ?out|timeout/i.test(stderr) || err.killed) {
      throw new Error("Clone timed out -- the repository may be too large for the current depth/time limit.");
    }
    const message = stderr || err.message || String(err);
    throw new Error(`git clone failed: ${message.split("\n").pop().trim()}`);
  }
}

export function isLikelyGitRepo(repoPath) {
  if (!repoPath) return false;
  try {
    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(repoPath, ".git"));
}

export async function assertGitRepo(repoPath) {
  if (!isLikelyGitRepo(repoPath)) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
  await run(repoPath, ["rev-parse", "--is-inside-work-tree"]);
}

export async function getRepoName(repoPath) {
  return path.basename(path.resolve(repoPath));
}

export async function listBranches(repoPath) {
  const stdout = await run(repoPath, ["branch", "--list", "--format=%(refname:short)"]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function getCurrentRef(repoPath) {
  try {
    return (await run(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
  } catch {
    // Detached HEAD
    return (await run(repoPath, ["rev-parse", "--short", "HEAD"])).trim();
  }
}

export async function resolveRef(repoPath, ref) {
  if (ref === WORKING_TREE || ref === STAGED) return ref;
  return (await run(repoPath, ["rev-parse", ref])).trim();
}

/**
 * Produce a unified diff between two points in history.
 * head may be WORKING (working tree, includes unstaged changes) or STAGED
 * (the index) in addition to a normal commit-ish.
 */
export async function getDiff(repoPath, base, head) {
  await assertGitRepo(repoPath);

  if (head === STAGED) {
    return run(repoPath, ["diff", "--no-color", "--staged", base]);
  }
  if (head === WORKING_TREE) {
    return run(repoPath, ["diff", "--no-color", base]);
  }
  return run(repoPath, ["diff", "--no-color", `${base}..${head}`]);
}

export async function getChangedFileNames(repoPath, base, head) {
  await assertGitRepo(repoPath);
  let args;
  if (head === STAGED) args = ["diff", "--name-only", "--staged", base];
  else if (head === WORKING_TREE) args = ["diff", "--name-only", base];
  else args = ["diff", "--name-only", `${base}..${head}`];
  const stdout = await run(repoPath, args);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** List all git-tracked files (this naturally respects .gitignore). */
export async function listTrackedFiles(repoPath) {
  const stdout = await run(repoPath, ["ls-files"]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function readFileAtRef(repoPath, ref, filePath) {
  if (ref === WORKING_TREE) {
    return fs.promises.readFile(path.join(repoPath, filePath), "utf8");
  }
  try {
    return await run(repoPath, ["show", `${ref}:${filePath}`]);
  } catch {
    return null; // file did not exist at that ref (e.g. newly added)
  }
}

export async function commitMeta(repoPath, ref) {
  if (ref === WORKING_TREE || ref === STAGED) {
    return { ref, subject: ref === STAGED ? "Staged changes" : "Working tree", author: null, date: null };
  }
  const stdout = await run(repoPath, ["show", "-s", "--format=%H%n%an%n%ad%n%s", ref]);
  const [sha, author, date, ...subject] = stdout.split("\n");
  return { ref: sha, author, date, subject: subject.join("\n") };
}

export const REF = { WORKING_TREE, STAGED };
