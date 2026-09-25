import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, siblingsOf, checksBrief, prFacts, renderFacts } from "../src/facts.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// A fake api that answers the contents endpoint for two paths and fails for the
// rest, so the happy path and the failure path are both exercised.
function stubApi(files = { "a.js": "old a" }, { fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      const path = decodeURIComponent(url.split("?")[0].replace("/repos/o/r/contents/", ""));
      if (fail.includes(path)) throw new Error(`404 no such path ${path}`);
      if (!(path in files)) throw new Error(`404 ${path}`);
      return { content: b64(files[path]) };
    },
  };
}

test("the base version of each changed file is readable, so a diff-only blind spot is closed", async () => {
  const api = stubApi({ "src/a.js": "old a", "src/b.js": "old b" });
  const out = await baselineOf(api, "o/r", "main", [{ filename: "src/a.js" }, { filename: "src/b.js" }]);
  assert.equal(out.get("src/a.js"), "old a");
  assert.equal(out.get("src/b.js"), "old b");
  assert.ok(api.calls.every((c) => c.includes("ref=main")), "every read is pinned to the base ref, not the head");
});

test("a file that cannot be read is null, and one failure does not stop the rest", async () => {
  const api = stubApi({ "a.js": "old a", "c.js": "old c" }, { fail: ["b.js"] });
  const out = await baselineOf(api, "o/r", "main", [{ filename: "a.js" }, { filename: "b.js" }, { filename: "c.js" }]);
  assert.equal(out.get("a.js"), "old a");
  assert.equal(out.get("b.js"), null, "an unreadable file is null, never a guess");
  assert.equal(out.get("c.js"), "old c", "the failure on b did not stop c");
});

test("ignored and removed files are not even fetched", async () => {
  const api = stubApi({ "dist/x.js": "old x" });
  const out = await baselineOf(api, "o/r", "main", [{ filename: "dist/x.js" }, { filename: "gone.js", status: "removed" }], { ignore_paths: ["dist/"] });
  assert.equal(out.get("dist/x.js"), null);
  assert.equal(out.get("gone.js"), null);
  assert.deepEqual(api.calls, [], "no contents calls for a path we will not show");
});

test("a path with a slash in it is not mangled into one segment", async () => {
  const api = stubApi({ "a/b/c.js": "deep" });
  const out = await baselineOf(api, "o/r", "main", [{ filename: "a/b/c.js" }]);
  assert.equal(out.get("a/b/c.js"), "deep");
  assert.ok(api.calls[0].includes("/contents/a/b/c.js"), api.calls[0]);
});

test("a new file has no base version, so its neighbours are listed instead", async () => {
  // The case a diff-only review gets wrong: a PR adds a workflow, and the model
  // cannot see the workflows already in the repo, so it reports a setting as
  // wrong when the neighbours already use it.
  const api = {
    get: async (url) => {
      const p = decodeURIComponent(url.split("?")[0].replace("/repos/o/r/contents/", ""));
      if (p === ".github/workflows/") return [{ name: "test.yml" }, { name: "review.yml" }, { name: "deploy-worker.yml" }];
      throw new Error(`404 ${p}`);
    },
  };
  const files = [{ filename: ".github/workflows/refresh-models.yml", status: "added" }];
  const baseline = await baselineOf(api, "o/r", "master", files);
  assert.equal(baseline.get(".github/workflows/refresh-models.yml"), null, "an added file has no base version");
  const siblings = await siblingsOf(api, "o/r", "master", files);
  assert.deepEqual(siblings.get(".github/workflows"), ["deploy-worker.yml", "review.yml", "test.yml"]);

  const text = renderFacts({ baseline, siblings, checks: "- Test: success", pr: "files changed: 1" });
  assert.match(text, /### what else is in \.github\/workflows on the base branch/, text);
  assert.match(text, /- deploy-worker\.yml\n- review\.yml\n- test\.yml/, "the neighbours are listed, sorted, so the model can see this is a repo that already has workflows");
  assert.match(text, /a file this pull request adds does not exist yet/, "the gap is explained, not silent");
  assert.ok(!/### \.github\/workflows\/refresh-models\.yml/.test(text), "no fake base for the added file");
});

test("a directory that cannot be listed is named as a gap, not shown as empty", async () => {
  const api = { get: async () => { throw new Error("404"); } };
  const siblings = await siblingsOf(api, "o/r", "master", [{ filename: "src/new.js" }]);
  assert.equal(siblings.get("src"), null);
  const text = renderFacts({ baseline: new Map([["src/new.js", null]]), siblings, checks: "- Test: success" });
  assert.match(text, /could not list: src/);
  assert.ok(!/what else is in src/.test(text), "a null listing is not rendered as an empty folder");
});

test("each folder is listed once, however many files came from it", async () => {
  const calls = [];
  const api = {
    get: async (url) => {
      calls.push(url);
      return [{ name: "a.js" }, { name: "b.js" }];
    },
  };
  await siblingsOf(api, "o/r", "main", [{ filename: "src/a.js" }, { filename: "src/b.js" }, { filename: "src/c.js" }]);
  assert.deepEqual(calls, ["/repos/o/r/contents/src/?ref=main"], "one call per folder, not per file");
});

test("the checks at head are the evidence, so a build outcome is not predicted", () => {
  assert.equal(checksBrief([{ name: "Test", status: "completed", conclusion: "success" }]), "- Test: success");
  assert.equal(checksBrief([{ name: "Lint", status: "in_progress", conclusion: null }]), "- Lint: in_progress");
  assert.equal(checksBrief([{ name: "a", status: "completed", conclusion: "failure" }, { name: "b", status: "completed", conclusion: "success" }], { more: 3 }), "- a: failure\n- b: success\n- and 3 more");
  assert.equal(checksBrief(null), null, "no checks is nothing to show, not a placeholder");
  assert.equal(checksBrief([]), null);
});

test("the facts block names what was not available, so a gap is not read as an all-clear", () => {
  const text = renderFacts({ baseline: new Map([["a.js", "old a"], ["b.js", null]]), checks: "- Test: success", pr: "files changed: 2" });
  assert.match(text, /## Facts gathered for this review/);
  assert.match(text, /### a\.js as it is on the base branch/);
  assert.match(text, /old a/);
  assert.match(text, /### checks at the head commit\n- Test: success/);
  assert.match(text, /no base version available for: b\.js/, "the file it could not read is named");
  assert.match(text, /nothing here is the result of running the code/);
  assert.ok(!/### b\.js/.test(text), "a null baseline is not shown as if it had content");
});

test("no facts at all is no facts block, rather than an empty heading", () => {
  assert.equal(renderFacts({}), "");
  assert.equal(renderFacts({ baseline: new Map([["a.js", null]]) }), "", "a baseline of all nulls has nothing to show");
});

test("the pull request describes itself, so a code and description mismatch is visible", () => {
  const facts = prFacts({ pr: { title: "Add a thing", body: "It does X" }, files: [{}, {}], baseRef: "main" });
  assert.match(facts, /base branch: main/);
  assert.match(facts, /files changed: 2/);
  assert.match(facts, /title: Add a thing/);
  assert.match(facts, /It does X/);
  assert.match(prFacts({ pr: {}, files: [{}] }), /files changed: 1/, "a PR with no title or body still yields the basics");
});

test("a long base file is truncated rather than filling the prompt", () => {
  const big = "x".repeat(9000);
  const text = renderFacts({ baseline: new Map([["a.js", big]]) });
  assert.match(text, /\.\.\. \(truncated\)/);
  assert.ok(text.length < 6000, `kept it to ${text.length} chars`);
});
