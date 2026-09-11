import { test } from "node:test";
import assert from "node:assert/strict";
import { redactor } from "../src/log.js";

const job = { repo: "SecretOrg/private-thing", author: "helper-bot", sender: "octocat", ref: "a1b2c3d4" };

test("scrub replaces repo, owner, name, author and sender", () => {
  const { scrub } = redactor(job);
  assert.equal(scrub("GET /repos/SecretOrg/private-thing/pulls/3 -> 404"), "GET /repos/<repo>/pulls/3 -> 404");
  assert.equal(scrub("author helper-bot is not on the list"), "author <author> is not on the list");
  assert.equal(scrub("/review from OCTOCAT"), "/review from <sender>");
  assert.equal(scrub("repo secretorg is not allowed"), "repo <owner> is not allowed");
  assert.equal(scrub("touched private-thing/src"), "touched <name>/src");
});

test("scrub leaves everything else alone and survives a bare job", () => {
  assert.equal(redactor(job).scrub("posted review: 2 inline, 0 in body"), "posted review: 2 inline, 0 in body");
  assert.equal(redactor({}).scrub("no job fields"), "no job fields");
});
