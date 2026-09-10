import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/prompt.js";

test("parses fenced JSON and normalises fields", () => {
  const r = parseReview('Here you go:\n```json\n{"summary":" ok ","verdict":"approve","comments":[{"path":"a.js","line":"3","body":" x "},{"path":"b.js","body":""}]}\n```');
  assert.equal(r.summary, "ok");
  assert.equal(r.verdict, "approve");
  assert.deepEqual(r.comments, [{ path: "a.js", line: 3, body: "x" }]);
});

test("falls back to raw text when the model does not return JSON", () => {
  const r = parseReview("Looks fine to me.");
  assert.deepEqual(r, { summary: "Looks fine to me.", verdict: "comment", comments: [] });
});

test("unknown verdicts become comment", () => {
  assert.equal(parseReview('{"summary":"s","verdict":"lgtm"}').verdict, "comment");
});
