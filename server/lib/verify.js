import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60_000;

/**
 * Detect the repository's own verification commands rather than inventing
 * one. Currently supports Node projects (package.json scripts); the shape
 * is intentionally easy to extend with pyproject.toml/Cargo.toml/Makefile
 * detection later without touching callers.
 */
export function detectVerificationCommands(repoPath) {
  const commands = [];
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts || {};
      if (scripts.test) commands.push({ name: "test", cmd: "npm", args: ["test", "--silent"] });
      if (scripts.lint) commands.push({ name: "lint", cmd: "npm", args: ["run", "lint", "--silent"] });
      if (scripts.typecheck) commands.push({ name: "typecheck", cmd: "npm", args: ["run", "typecheck", "--silent"] });
    } catch {
      // malformed package.json; nothing we can safely run
    }
  }
  return commands;
}

async function runCommand(repoPath, { name, cmd, args }) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: repoPath,
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 16,
    });
    return { name, cmd: `${cmd} ${args.join(" ")}`, status: "pass", durationMs: Date.now() - startedAt, stdout, stderr };
  } catch (err) {
    const timedOut = err.killed && err.signal === "SIGTERM";
    return {
      name,
      cmd: `${cmd} ${args.join(" ")}`,
      status: timedOut ? "timeout" : "fail",
      durationMs: Date.now() - startedAt,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || String(err),
    };
  }
}

export async function runVerification(repoPath) {
  const commands = detectVerificationCommands(repoPath);
  if (commands.length === 0) {
    return { ranAt: new Date().toISOString(), commands: [], results: [], note: "No test/lint/typecheck script found in package.json." };
  }
  const results = [];
  for (const command of commands) {
    results.push(await runCommand(repoPath, command));
  }
  return { ranAt: new Date().toISOString(), commands: commands.map((c) => c.name), results };
}
