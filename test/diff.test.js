import { test } from "node:test";
import assert from "node:assert/strict";
import { ignored, validLines, renderDiff } from "../src/diff.js";

test("ignored matches names, suffixes and directories", () => {
  const pats = ["pnpm-lock.yaml", "*.snap", "dist/"];
  assert.equal(ignored("pnpm-lock.yaml", pats), true);
  assert.equal(ignored("app/pnpm-lock.yaml", pats), true);
  assert.equal(ignored("test/__snapshots__/a.snap", pats), true);
  assert.equal(ignored("dist/main.js", pats), true);
  assert.equal(ignored("pkg/dist/main.js", pats), true);
  assert.equal(ignored("src/dist.js", pats), false);
});

const patch = `@@ -1,3 +1,4 @@
 a
-b
+B
+C
 d
@@ -10,2 +11,2 @@
 x
+y`;

test("validLines follows hunk headers on the new side", () => {
  const lines = [...validLines(patch)].sort((a, b) => a - b);
  assert.deepEqual(lines, [1, 2, 3, 4, 11, 12]);
  assert.equal(validLines(undefined).size, 0);
});

test("renderDiff skips ignored and binary files and honours the budget", () => {
  const files = [
    { filename: "a.js", status: "modified", additions: 2, deletions: 1, patch },
    { filename: "pnpm-lock.yaml", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    { filename: "big.js", status: "added", additions: 1, deletions: 0, patch: "+".repeat(5000) },
  ];
  const { text, omitted } = renderDiff(files, { ignore_paths: ["pnpm-lock.yaml"], max_diff_chars: 200 });
  assert.match(text, /### a\.js/);
  assert.doesNotMatch(text, /pnpm-lock/);
  assert.deepEqual(
    omitted.map((o) => o.path),
    ["pnpm-lock.yaml", "logo.png", "big.js"],
  );
  assert.ok(text.length <= 200);
});
