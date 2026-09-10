import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { pick, verify } from "../worker/index.js";

const repo = { repository: { full_name: "Project516/x" }, installation: { id: 7 } };

test("pick forwards PR events the reviewer acts on", () => {
  const p = { ...repo, action: "synchronize", pull_request: { number: 3, user: { login: "cappy-dev" }, draft: false }, sender: { login: "Project516" } };
  assert.deepEqual(pick("pull_request", p), {
    repo: "Project516/x", installation: 7, action: "synchronize", event: "pull_request", pr: 3, author: "cappy-dev", draft: false, sender: "Project516",
  });
  assert.equal(pick("pull_request", { ...p, action: "labeled" }), null);
});

test("pick forwards /review comments on PRs only", () => {
  const p = { ...repo, action: "created", issue: { number: 9, pull_request: {}, user: { login: "someone" } }, comment: { id: 11, body: "  /review please", user: { login: "Project516" } } };
  assert.equal(pick("issue_comment", p).comment_id, 11);
  assert.equal(pick("issue_comment", { ...p, comment: { ...p.comment, body: "nice" } }), null);
  assert.equal(pick("issue_comment", { ...p, issue: { number: 9, user: { login: "someone" } } }), null);
});

test("verify accepts a good signature and rejects bad ones", async () => {
  const body = '{"a":1}';
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(await verify("s3cret", sig, body), true);
  assert.equal(await verify("other", sig, body), false);
  assert.equal(await verify("s3cret", sig, body + " "), false);
  assert.equal(await verify("s3cret", "sha256=zz", body), false);
  assert.equal(await verify("s3cret", null, body), false);
});
