import { test } from "node:test";
import assert from "node:assert/strict";
import { ignored, validLines, lineTexts, renderDiff, splitComments, anchorByQuote } from "../src/diff.js";

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
  const { text, omitted } = renderDiff(files, { ignore_paths: ["pnpm-lock.yaml"], max_diff_chars: 400 });
  assert.match(text, /### a\.js/);
  assert.doesNotMatch(text, /pnpm-lock/);
  assert.deepEqual(
    omitted.map((o) => o.path),
    ["pnpm-lock.yaml", "logo.png", "big.js"],
  );
  assert.ok(text.length <= 400);
});

test("splitComments separates inline from stray comments", () => {
  const valid = new Map([["a.js", new Set([1, 2])]]);
  const comments = [
    { path: "a.js", line: 1, body: "fix this" },
    { path: "a.js", line: 99, body: "not in the diff" },
    { path: "b.js", line: 1, body: "unknown file" },
  ];
  const { inline, stray, dropped } = splitComments(comments, valid, "comment");
  assert.deepEqual(inline, [{ path: "a.js", line: 1, side: "RIGHT", body: "fix this" }]);
  assert.deepEqual(stray, [comments[1], comments[2]]);
  assert.equal(dropped, 0);
});

test("splitComments drops everything on an approve verdict", () => {
  const valid = new Map([["a.js", new Set([1])]]);
  const comments = [{ path: "a.js", line: 1, body: "nice job" }];
  const { inline, stray, dropped } = splitComments(comments, valid, "approve");
  assert.deepEqual(inline, []);
  assert.deepEqual(stray, []);
  assert.equal(dropped, 1);
});

test("each commentable line is numbered for the model, and a removed line is not", () => {
  const { text } = renderDiff([{ filename: "a.js", status: "modified", additions: 2, deletions: 1, patch }]);
  assert.match(text, /^ {5}1 {2} a$/m, "a context line carries its number");
  assert.match(text, /^ {6} {2}-b$/m, "a removed line has none");
  assert.match(text, /^ {5}2 {2}\+B$/m);
  assert.match(text, /^ {4}12 {2}\+y$/m, "the number follows the hunk header, not a running count");
});

test("a file whose diff was cut short is reported, and one left out whole is not listed twice", () => {
  const big = `@@ -0,0 +1,300 @@\n${Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n")}`;
  const files = [{ filename: "big.js", status: "added", additions: 300, deletions: 0, patch: big }];
  const { text, cut, omitted } = renderDiff(files, { max_diff_chars: 9000 });
  assert.deepEqual(cut, ["big.js"]);
  assert.deepEqual(omitted, []);
  assert.match(text, /\(truncated\)/);
  assert.deepEqual(renderDiff(files, { max_diff_chars: 50 }).cut, []);
});

test("lineTexts maps new-side lines to their text", () => {
  assert.deepEqual([...lineTexts(patch)], [[1, "a"], [2, "B"], [3, "C"], [4, "d"], [11, "x"], [12, "y"]]);
});

test("a comment keeps its line when the quote is there, moves to the one line that has it, and is unanchored otherwise", () => {
  const long = "@@ -1,3 +1,3 @@\n const alpha = 1;\n+const beta = 2;\n const gamma = 3;";
  const patches = new Map([["a.js", long]]);
  const at = (line, quote) => anchorByQuote([{ path: "a.js", line, quote, body: "b" }], patches)[0].line;
  assert.equal(at(2, "const   beta = 2;"), 2, "whitespace does not matter");
  assert.equal(at(1, "const beta = 2;"), 2, "the single line holding the quote wins");
  assert.ok(Number.isNaN(at(1, "const delta = 4;")), "a quote found nowhere unanchors the comment");
  assert.equal(at(3, ""), 3, "no quote, no check");
  assert.equal(at(3, "b"), 3, "a quote too short to mean anything is not checked");
});

test("a review that asks for changes with no inline comment is a comment", () => {
  const valid = new Map([["a.js", new Set([1])]]);
  const stray = [{ path: "a.js", line: 50, body: "x" }];
  assert.equal(splitComments(stray, valid, "request_changes").verdict, "comment");
  assert.equal(splitComments([], valid, "request_changes").verdict, "comment");
  assert.equal(splitComments([{ path: "a.js", line: 1, body: "x" }], valid, "request_changes").verdict, "request_changes");
  assert.equal(splitComments(stray, valid, "approve").verdict, "approve");
});

test("source files are drawn before test files, and a file that does not fit whole is cut instead of dropped", () => {
  const body = (n) => `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n")}`;
  const file = (filename) => ({ filename, status: "added", additions: 150, deletions: 0, patch: body(150) });
  const { text, omitted, cut } = renderDiff([file("test/a.test.js"), file("src/b.js"), file("src/c.js")], { max_diff_chars: 5000 });
  assert.ok(text.indexOf("### src/b.js") < text.indexOf("### src/c.js"));
  assert.deepEqual(cut, ["src/b.js", "src/c.js"], "a source file shows its start and says so");
  assert.deepEqual(omitted, [{ path: "test/a.test.js", reason: "diff budget exhausted" }], "the test file is what the budget could not hold");
});

test("the file named first is drawn before the rest, even a test file", () => {
  const f = (filename) => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" });
  const { text } = renderDiff([f("src/a.js"), f("test/b.test.js")], { first: "test/b.test.js" });
  assert.ok(text.indexOf("test/b.test.js") < text.indexOf("src/a.js"));
});
