import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.js";

const cfg = { owner: "Project516", allowed_repo_owners: ["Project516"], allowed_authors: ["Project516", "cappy-dev"] };
const pr = (over) => ({ event: "pull_request", action: "opened", repo: "Project516/x", pr: 1, author: "Project516", sender: "Project516", draft: false, ...over });

test("reviews PRs from allowed authors, case insensitive", () => {
  assert.equal(decide(pr(), cfg).review, true);
  assert.equal(decide(pr({ author: "CAPPY-DEV" }), cfg).review, true);
});

test("skips PRs from strangers and drafts", () => {
  assert.equal(decide(pr({ author: "someone" }), cfg).review, false);
  assert.equal(decide(pr({ draft: true }), cfg).review, false);
});

test("skips repos owned by others even for allowed authors", () => {
  assert.equal(decide(pr({ repo: "OtherOrg/x" }), cfg).review, false);
});

test("/review by owner forces a review of anyone's PR", () => {
  const d = decide(pr({ event: "issue_comment", action: "created", author: "someone", sender: "project516", comment_id: 5 }), cfg);
  assert.deepEqual([d.review, d.forced], [true, true]);
});

test("/review by anyone else is ignored", () => {
  assert.equal(decide(pr({ event: "issue_comment", sender: "cappy-dev" }), cfg).review, false);
});
