import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.js";

const cfg = { owner: "octocat", allowed_repo_owners: ["octocat"], allowed_authors: ["octocat", "helper-bot"] };
const pr = (over) => ({ event: "pull_request", action: "opened", repo: "octocat/x", pr: 1, author: "octocat", sender: "octocat", draft: false, ...over });

test("reviews PRs from allowed authors, case insensitive", () => {
  assert.equal(decide(pr(), cfg).review, true);
  assert.equal(decide(pr({ author: "HELPER-BOT" }), cfg).review, true);
});

test("skips PRs from strangers and drafts", () => {
  assert.equal(decide(pr({ author: "someone" }), cfg).review, false);
  assert.equal(decide(pr({ draft: true }), cfg).review, false);
});

test("skips repos owned by others even for allowed authors", () => {
  assert.equal(decide(pr({ repo: "OtherOrg/x" }), cfg).review, false);
});

test("/review by owner forces a review of anyone's PR", () => {
  const d = decide(pr({ event: "issue_comment", action: "created", author: "someone", sender: "octocat", comment_id: 5 }), cfg);
  assert.deepEqual([d.review, d.forced], [true, true]);
});

test("/review by anyone else is ignored", () => {
  assert.equal(decide(pr({ event: "issue_comment", sender: "helper-bot" }), cfg).review, false);
});
