import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCloneUrl } from "../server/lib/git.js";

test("validateCloneUrl accepts https and http URLs", () => {
  assert.equal(validateCloneUrl("https://github.com/owner/repo"), "https://github.com/owner/repo");
  assert.doesNotThrow(() => validateCloneUrl("http://example.com/repo.git"));
});

test("validateCloneUrl rejects non-http(s) schemes (ssh, git, file)", () => {
  assert.throws(() => validateCloneUrl("git@github.com:owner/repo.git"));
  assert.throws(() => validateCloneUrl("ssh://git@github.com/owner/repo.git"));
  assert.throws(() => validateCloneUrl("git://github.com/owner/repo.git"));
  assert.throws(() => validateCloneUrl("file:///etc/passwd"));
});

test("validateCloneUrl rejects garbage input", () => {
  assert.throws(() => validateCloneUrl("not a url"));
  assert.throws(() => validateCloneUrl(""));
});
