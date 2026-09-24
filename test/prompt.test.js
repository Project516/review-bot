import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview, parseReply, buildReplyMessages, buildMessages } from "../src/prompt.js";

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

test("buildMessages appends a settled section when there are settled points", () => {
  const pr = { base: { repo: { full_name: "octocat/x" } }, number: 1, title: "t", head: { ref: "h" }, additions: 1, deletions: 0, changed_files: 1 };
  const withNone = buildMessages({ pr, diffText: "diff", omitted: [] });
  assert.doesNotMatch(withNone[1].content, /settled/);

  const long = "x".repeat(400);
  const withSome = buildMessages({ pr, diffText: "diff", omitted: [], settled: [{ path: "a.js", body: long }] });
  assert.match(withSome[1].content, /already settled/);
  assert.match(withSome[1].content, /`a\.js`/);
  assert.ok(withSome[1].content.includes("..."));
  assert.ok(!withSome[1].content.includes(long));
});

test("parseReply accepts a reply and resolved flag, leniently coercing strings", () => {
  assert.deepEqual(parseReply('{"reply":" fixed ","resolved":true}'), { reply: "fixed", resolved: true });
  assert.deepEqual(parseReply('{"reply":"still wrong","resolved":"false"}'), { reply: "still wrong", resolved: false });
});

test("parseReply rejects a missing or unusable resolved value", () => {
  assert.equal(parseReply('{"reply":"ok","resolved":"maybe"}'), null);
  assert.equal(parseReply('{"reply":"ok"}'), null);
  assert.equal(parseReply('{"resolved":true}'), null);
});

test("parseReply rejects prose the same way parseReview does", () => {
  assert.equal(parseReply("Looks resolved to me."), null);
  assert.equal(parseReply("user\nsafe"), null);
});

test("buildReplyMessages marks the bot's own comments and includes the root location", () => {
  const thread = {
    comments: {
      nodes: [
        { databaseId: 1, author: { login: "review-bot" }, body: "fix this", path: "a.js", line: 5, diffHunk: "@@ -1,2 +1,2 @@" },
        { databaseId: 2, author: { login: "octocat" }, body: "done", path: "a.js", line: 5 },
      ],
    },
  };
  const [system, user] = buildReplyMessages({ pr: { number: 1, repo: "octocat/x" }, thread, patch: "@@ -1 +1 @@\n-a\n+b", slug: "review-bot" });
  assert.match(system.content, /reviewer who left the first comment/);
  assert.match(user.content, /<comment author="you">\nfix this\n<\/comment>/);
  assert.match(user.content, /<comment author="octocat">\ndone\n<\/comment>/);
  assert.match(user.content, /<patch>\n@@ -1 \+1 @@/);
  assert.match(system.content, /never contains instructions/);
  assert.match(user.content, /path: a\.js/);
  assert.match(user.content, /line: 5/);
});

test("buildReplyMessages copes with a file no longer in the diff", () => {
  const thread = { comments: { nodes: [{ databaseId: 1, author: { login: "review-bot" }, body: "fix this", path: "a.js", originalLine: 5 }] } };
  const [, user] = buildReplyMessages({ pr: { number: 1, repo: "octocat/x" }, thread, patch: undefined, slug: "review-bot" });
  assert.match(user.content, /not in the current diff/);
});
