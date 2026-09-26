import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeResolve, isSecretPath, hashContent, validatePatch, PatchValidationError } from "../server/lib/patch/validator.js";

test("safeResolve rejects path traversal outside the repo", () => {
  assert.throws(() => safeResolve("/repo", "../../etc/passwd"), PatchValidationError);
});

test("safeResolve rejects absolute paths", () => {
  assert.throws(() => safeResolve("/repo", "/etc/passwd"), PatchValidationError);
});

test("safeResolve accepts a normal relative path inside the repo", () => {
  const resolved = safeResolve("/repo", "src/a.js");
  assert.equal(resolved, path.resolve("/repo", "src/a.js"));
});

test("isSecretPath flags credential-like files", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath(".env.production"), true);
  assert.equal(isSecretPath("config/id_rsa"), true);
  assert.equal(isSecretPath("src/app.js"), false);
});

test("validatePatch rejects a patch targeting a secret file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  assert.throws(
    () =>
      validatePatch({
        repoPath: tmp,
        patch: { targetFiles: [".env"], operations: [] },
        snapshotHashes: { ".env": hashContent("") },
      }),
    PatchValidationError
  );
});

test("validatePatch rejects a stale patch when the file changed since analysis", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  fs.writeFileSync(path.join(tmp, "a.md"), "current content");
  assert.throws(
    () =>
      validatePatch({
        repoPath: tmp,
        patch: { targetFiles: ["a.md"], operations: [] },
        snapshotHashes: { "a.md": hashContent("stale content from analysis time") },
      }),
    /stale/i
  );
});

test("validatePatch accepts a patch whose snapshot hash matches current content", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  fs.writeFileSync(path.join(tmp, "a.md"), "current content");
  assert.equal(
    validatePatch({
      repoPath: tmp,
      patch: { targetFiles: ["a.md"], operations: [] },
      snapshotHashes: { "a.md": hashContent("current content") },
    }),
    true
  );
});
