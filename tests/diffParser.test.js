import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, summarizeDiff } from "../server/lib/diffParser.js";

const SAMPLE = `diff --git a/backend/models/order.js b/backend/models/order.js
index 1111111..2222222 100644
--- a/backend/models/order.js
+++ b/backend/models/order.js
@@ -5,7 +5,7 @@ const orders = new Map([
     "ORD-1001",
     {
       id: "ORD-1001",
-      customerName: "Priya Nair",
+      name: "Priya Nair",
       total: 129.5,
diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,2 @@
+line one
+line two
diff --git a/removed.txt b/removed.txt
deleted file mode 100644
index 4444444..0000000
--- a/removed.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
diff --git a/image.png b/image.png
index 5555555..6666666 100644
Binary files a/image.png and b/image.png differ
`;

test("parses modified file hunks with correct add/del line numbers", () => {
  const files = parseUnifiedDiff(SAMPLE);
  const modified = files.find((f) => f.newPath === "backend/models/order.js");
  assert.ok(modified);
  assert.equal(modified.status, "modified");
  assert.equal(modified.additions, 1);
  assert.equal(modified.deletions, 1);
  const hunk = modified.hunks[0];
  const del = hunk.lines.find((l) => l.type === "del");
  const add = hunk.lines.find((l) => l.type === "add");
  assert.equal(del.content.trim(), 'customerName: "Priya Nair",');
  assert.equal(add.content.trim(), 'name: "Priya Nair",');
  assert.equal(add.newLineNo, del.oldLineNo); // same position, replaced in place
});

test("detects added, deleted, and binary files", () => {
  const files = parseUnifiedDiff(SAMPLE);
  const added = files.find((f) => f.newPath === "newfile.txt");
  const deleted = files.find((f) => f.oldPath === "removed.txt");
  const binary = files.find((f) => f.newPath === "image.png");
  assert.equal(added.status, "added");
  assert.equal(added.additions, 2);
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.deletions, 1);
  assert.equal(binary.isBinary, true);
});

test("summarizeDiff aggregates counts across files", () => {
  const files = parseUnifiedDiff(SAMPLE);
  const summary = summarizeDiff(files);
  assert.equal(summary.filesChanged, 4);
  assert.equal(summary.added.includes("newfile.txt"), true);
  assert.equal(summary.deleted.includes("removed.txt"), true);
  assert.equal(summary.binaryFiles.includes("image.png"), true);
});

test("parseUnifiedDiff returns empty array for empty diff", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff(null), []);
});
