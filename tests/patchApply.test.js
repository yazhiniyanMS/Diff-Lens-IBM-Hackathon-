import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatch } from "../server/lib/patch/apply.js";
import { hashContent, PatchValidationError } from "../server/lib/patch/validator.js";

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-apply-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test("applyPatch performs a replace_all operation and reports touched files", () => {
  const content = "The field is customerName in the response.";
  const dir = tmpRepo({ "docs/api.md": content });
  const patch = {
    findingId: "f1",
    targetFiles: ["docs/api.md"],
    operations: [{ file: "docs/api.md", kind: "replace_all", find: "customerName", replace: "name" }],
  };
  const result = applyPatch({ repoPath: dir, patch, snapshotHashes: { "docs/api.md": hashContent(content) } });
  assert.deepEqual(result.touchedFiles, ["docs/api.md"]);
  const after = fs.readFileSync(path.join(dir, "docs/api.md"), "utf8");
  assert.equal(after, "The field is name in the response.");
});

test("applyPatch performs insert_after_match without corrupting the rest of the file", () => {
  const content = "line1\nassert customerName\nline3\n";
  const dir = tmpRepo({ "t.js": content });
  const patch = {
    findingId: "f2",
    targetFiles: ["t.js"],
    operations: [{ file: "t.js", kind: "insert_after_match", match: "customerName", insertText: "assert name" }],
  };
  applyPatch({ repoPath: dir, patch, snapshotHashes: { "t.js": hashContent(content) } });
  const after = fs.readFileSync(path.join(dir, "t.js"), "utf8");
  assert.equal(after, "line1\nassert customerName\nassert name\nline3\n");
});

test("applyPatch refuses to run when the file changed since analysis (staleness)", () => {
  const dir = tmpRepo({ "docs/api.md": "current on disk" });
  const patch = {
    findingId: "f3",
    targetFiles: ["docs/api.md"],
    operations: [{ file: "docs/api.md", kind: "replace_all", find: "x", replace: "y" }],
  };
  assert.throws(
    () => applyPatch({ repoPath: dir, patch, snapshotHashes: { "docs/api.md": hashContent("stale snapshot") } }),
    PatchValidationError
  );
  // file must be untouched
  assert.equal(fs.readFileSync(path.join(dir, "docs/api.md"), "utf8"), "current on disk");
});

test("applyPatch refuses a path that escapes the repository root", () => {
  const dir = tmpRepo({ "a.md": "x" });
  const patch = {
    findingId: "f4",
    targetFiles: ["../../etc/passwd"],
    operations: [{ file: "../../etc/passwd", kind: "replace_all", find: "x", replace: "y" }],
  };
  assert.throws(() => applyPatch({ repoPath: dir, patch, snapshotHashes: { "../../etc/passwd": hashContent("") } }), PatchValidationError);
});
