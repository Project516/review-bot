// Tests for the house style applied to model output.
//
// The rule under test is not "no em dash" on its own, it is "no em dash and
// still readable prose". A rewrite that mangles the sentence fails here even
// when it removes the dash, because a broken review is worse than a dashed one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEmDashes } from "../src/style.js";

// hasDash reports whether any long dash survived. The bare hyphen and the minus
// sign are not counted, since a hyphenated word is fine.
const hasDash = (s) => /[—–‒―−]/.test(s);

test("a dash between two clause halves becomes a comma", () => {
  assert.equal(stripEmDashes("This is a bug — the loop breaks early."), "This is a bug, the loop breaks early.");
});

test("a matched pair of dashes becomes a pair of commas", () => {
  assert.equal(
    stripEmDashes("The value — which is null here — is never checked."),
    "The value, which is null here, is never checked.",
  );
});

test("a dash after a finished sentence becomes a space, not a second full stop", () => {
  // The failure that made this rule: "ended.." , then "ended. ." . The left side
  // already carries its own punctuation, so the dash can only be a space.
  const out = stripEmDashes("already ended. — Next sentence.");
  assert.equal(out, "already ended. Next sentence.");
  assert.doesNotMatch(out, /\.\./, out);
  assert.doesNotMatch(out, /\s\./, out);
});

test("a dash inside parentheses becomes a space, keeping the brackets", () => {
  assert.equal(stripEmDashes("An aside (like this — really) closes."), "An aside (like this really) closes.");
});

test("a run of dashes does not leave a space behind each one", () => {
  // The double space came from keeping the space the replacement had already
  // supplied, so this pins the join rather than the punctuation.
  assert.equal(stripEmDashes("A — B — C — D chain"), "A, B, C, D chain");
  for (const run of ["A — B", "x — y — z", "one — two — three — four"]) {
    assert.doesNotMatch(stripEmDashes(run), /  /, `doubled space in: ${run}`);
  }
});

test("a dash at the end of a line keeps the line break", () => {
  assert.equal(stripEmDashes("a —\nb"), "a,\nb");
});

test("the other long dashes are rewritten too", () => {
  assert.equal(stripEmDashes("short – dash"), "short, dash");
  assert.equal(stripEmDashes("figure – dash"), "figure, dash");
  assert.equal(stripEmDashes("minus − sign"), "minus, sign");
});

test("hyphens, ranges and flags are left alone", () => {
  for (const keep of [
    "Range 5-10 and -1 and a-b stay put.",
    "The bot uses `--dry-run` and 3 - 2 = 1.",
    "-m and --flag pass the -m check",
    "well-known and state-of-the-art",
    "404-500 range",
  ]) {
    assert.equal(stripEmDashes(keep), keep, `must not change: ${keep}`);
  }
});

test("a dash in code is never rewritten", () => {
  assert.equal(stripEmDashes("`code — stays` and `another — one`"), "`code — stays` and `another — one`");
  const fenced = "```js\nconst a = 1; // — in code\n```";
  assert.equal(stripEmDashes(fenced), fenced);
  assert.equal(stripEmDashes("see [the docs](https://x.dev/a—b) here"), "see [the docs](https://x.dev/a—b) here");
  assert.equal(stripEmDashes("<!-- a — b -->"), "<!-- a — b -->");
});

test("a list bullet and a table row keep their markers", () => {
  assert.equal(stripEmDashes("- first — item"), "- first, item");
  assert.equal(stripEmDashes("A | B — C | D row"), "A | B — C | D row");
});

test("text with no long dash is returned untouched", () => {
  const text = "Nothing to do here, and hyphens everywhere: well-known, 5-10, -m.";
  assert.equal(stripEmDashes(text), text);
  assert.equal(stripEmDashes(""), "");
});

test("a non-string is returned as it came in", () => {
  assert.equal(stripEmDashes(null), null);
  assert.equal(stripEmDashes(undefined), undefined);
  assert.equal(stripEmDashes(42), 42);
});

test("every realistic case ends up dash free and grammatical", () => {
  // The cases that came out of a real review run, which is where the awkward
  // shapes turn up: paired asides, sentences that already ended, and dashes
  // jammed against punctuation.
  const cases = [
    "The value — which is null here — is never checked.",
    "This is a bug — the loop breaks early.",
    "Add a timeout — say 30s — to the fetch call.",
    "Two problems: a — b, and c — d.",
    "ends a question? — Yes it does.",
    "The fix: the value is null, and the guard — if there is one — is missing.",
  ];
  for (const c of cases) {
    const out = stripEmDashes(c);
    assert.equal(hasDash(out), false, `dash survived: ${out}`);
    assert.doesNotMatch(out, /  /, `doubled space: ${out}`);
    assert.doesNotMatch(out, /\s,|\s\./, `space before punctuation: ${out}`);
    // No word was lost or duplicated by the rewrite.
    const words = (s) => s.replace(/[—–‒―−]/g, "").match(/[A-Za-z]+/g) ?? [];
    assert.deepEqual(words(out), words(c), `words changed: ${c}`);
  }
});
