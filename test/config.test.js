import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { decide } from "../src/policy.js";

test("identities come from the secret, settings from the file", () => {
  const cfg = loadConfig(undefined, { REVIEWBOT_POLICY: '{"owner":"octocat","allowed_repo_owners":["octocat"],"allowed_authors":["helper-bot"]}' });
  assert.deepEqual([cfg.owner, cfg.allowed_repo_owners, cfg.allowed_authors], ["octocat", ["octocat"], ["helper-bot"]]);
  assert.ok(cfg.models.length > 0);
});

test("the checked-in file names nobody", () => {
  const cfg = loadConfig(undefined, {});
  assert.deepEqual([cfg.owner, cfg.allowed_repo_owners, cfg.allowed_authors], ["", [], []]);
});

test("without the secret nothing is reviewed", () => {
  const d = decide({ event: "pull_request", repo: "octocat/x", author: "octocat" }, loadConfig(undefined, {}));
  assert.equal(d.review, false);
  assert.match(d.reason, /REVIEWBOT_POLICY/);
});

test("the model list never falls back to the free router", () => {
  // The router hands some requests to tiny models and safety classifiers.
  const { models } = loadConfig(undefined, {});
  assert.ok(models.every((m) => m.endsWith(":free") && !m.startsWith("openrouter/")));
});
