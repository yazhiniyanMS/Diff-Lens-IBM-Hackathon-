/**
 * Deterministic unified-diff parser. Turns `git diff` output into a
 * structured representation: per-file status, hunks, and individual
 * added/removed/context lines with line numbers. No AI involved here —
 * this is ground truth extracted directly from the diff text.
 */

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(diffText) {
  const files = [];
  if (!diffText || !diffText.trim()) return files;

  const lines = diffText.split("\n");
  let current = null;
  let hunk = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fileMatch = line.match(FILE_HEADER_RE);
    if (fileMatch) {
      if (current) files.push(current);
      current = {
        oldPath: fileMatch[1],
        newPath: fileMatch[2],
        status: "modified",
        isBinary: false,
        isRenamed: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.isRenamed = true;
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("Binary files") || line.includes("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      oldLineNo = parseInt(hunkMatch[1], 10);
      newLineNo = parseInt(hunkMatch[3], 10);
      hunk = {
        oldStart: oldLineNo,
        oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: newLineNo,
        newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        header: hunkMatch[5] || "",
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", content: line.slice(1), newLineNo, oldLineNo: null });
      newLineNo++;
      current.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", content: line.slice(1), newLineNo: null, oldLineNo });
      oldLineNo++;
      current.deletions++;
    } else if (line.startsWith("\\ No newline")) {
      // ignore
    } else {
      hunk.lines.push({ type: "context", content: line.slice(1), newLineNo, oldLineNo });
      newLineNo++;
      oldLineNo++;
    }
  }
  if (current) files.push(current);
  return files;
}

export function summarizeDiff(files) {
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    binaryFiles: files.filter((f) => f.isBinary).map((f) => f.newPath),
    added: files.filter((f) => f.status === "added").map((f) => f.newPath),
    deleted: files.filter((f) => f.status === "deleted").map((f) => f.oldPath),
    renamed: files.filter((f) => f.status === "renamed").map((f) => `${f.oldPath} -> ${f.newPath}`),
    modified: files.filter((f) => f.status === "modified").map((f) => f.newPath),
  };
}
