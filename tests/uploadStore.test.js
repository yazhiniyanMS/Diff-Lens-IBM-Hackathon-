import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  newUploadDir,
  writeUploadedFiles,
  extractZip,
  resolveEffectiveRoot,
  assertSafeRelativePath,
} from "../server/lib/uploadStore.js";

test("newUploadDir creates a fresh, empty directory", () => {
  const dir = newUploadDir();
  assert.ok(fs.existsSync(dir));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("writeUploadedFiles reconstructs relative directory structure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-up-"));
  const files = [{ buffer: Buffer.from("a") }, { buffer: Buffer.from("b") }];
  writeUploadedFiles(dir, files, ["repo/.git/HEAD", "repo/src/index.js"]);
  assert.equal(fs.readFileSync(path.join(dir, "repo/.git/HEAD"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(dir, "repo/src/index.js"), "utf8"), "b");
});

test("writeUploadedFiles rejects a relative path that escapes the destination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-up-"));
  const files = [{ buffer: Buffer.from("evil") }];
  assert.throws(() => writeUploadedFiles(dir, files, ["../../etc/passwd"]));
});

test("extractZip writes entries from a well-formed zip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-zip-"));
  const zip = new AdmZip();
  zip.addFile("repo/README.md", Buffer.from("hello"));
  extractZip(dir, zip.toBuffer());
  assert.equal(fs.readFileSync(path.join(dir, "repo/README.md"), "utf8"), "hello");
});

test("assertSafeRelativePath rejects zip-slip style traversal (used by extractZip per-entry)", () => {
  // AdmZip's own addFile() sanitizes ".." out of entry names on creation,
  // so a malicious entry only shows up when *reading* a zip built by some
  // other tool that doesn't sanitize. extractZip guards every entry with
  // this same check before writing, so we verify the check itself directly.
  assert.throws(() => assertSafeRelativePath("../../evil.txt"));
  assert.throws(() => assertSafeRelativePath("/etc/passwd"));
  assert.throws(() => assertSafeRelativePath("a/../../b"));
  assert.doesNotThrow(() => assertSafeRelativePath("repo/src/index.js"));
});

test("resolveEffectiveRoot descends into a single top-level wrapper folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-root-"));
  fs.mkdirSync(path.join(dir, "my-repo", ".git"), { recursive: true });
  assert.equal(resolveEffectiveRoot(dir), path.join(dir, "my-repo"));
});

test("resolveEffectiveRoot stays put when there are multiple top-level entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-root-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "src"));
  assert.equal(resolveEffectiveRoot(dir), dir);
});
