import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../src/prompt.js";

test("parses fenced JSON and normalises fields", () => {
  const r = parseReview('Here you go:\n```json\n{"summary":" ok ","verdict":"approve","comments":[{"path":"a.js","line":"3","body":" x "},{"path":"b.js","body":""}]}\n```');
  assert.equal(r.summary, "ok");
  assert.equal(r.verdict, "approve");
  assert.deepEqual(r.comments, [{ path: "a.js", line: 3, body: "x" }]);
});

test("rejects prose so the caller retries instead of publishing it", () => {
  assert.equal(parseReview("Looks fine to me."), null);
});

test("rejects a chain of thought that never reached the JSON", () => {
  const trace = "We are given a PR that adds a workflow.\n\nLet's break down the changes:\n1. The step sets tags=(--tag x) and then\n\nThis is correct. However,";
  assert.equal(parseReview(trace), null);
});

test("rejects a safety classifier verdict", () => {
  assert.equal(parseReview("user\nsafe"), null);
  assert.equal(parseReview("unsafe\nS6"), null);
});

test("rejects an object with no summary", () => {
  assert.equal(parseReview('{"verdict":"approve","comments":[]}'), null);
});

test("drops a think block before looking for the review", () => {
  const r = parseReview('<think>maybe {"summary":"draft","verdict":"request_changes"} no</think>\n{"summary":"final","verdict":"approve"}');
  assert.equal(r.summary, "final");
  assert.equal(r.verdict, "approve");
});

test("unknown verdicts become comment", () => {
  assert.equal(parseReview('{"summary":"s","verdict":"lgtm"}').verdict, "comment");
});
