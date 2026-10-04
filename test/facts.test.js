import { test } from "node:test";
import assert from "node:assert/strict";
import { siblingsOf, checksBrief, prFacts, renderFacts } from "../src/facts.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("a new file is shown whole in the diff, so its neighbours are listed instead", async () => {
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
  const siblings = await siblingsOf(api, "o/r", "master", files);
  assert.deepEqual(siblings.get(".github/workflows"), ["deploy-worker.yml", "review.yml", "test.yml"]);

  const text = renderFacts({ context: new Map(), siblings, checks: "- Test: success", pr: "files changed: 1" });
  assert.match(text, /### what else is in \.github\/workflows on the base branch/, text);
  assert.match(text, /- deploy-worker\.yml\n- review\.yml\n- test\.yml/, "the neighbours are listed, sorted, so the model can see this is a repo that already has workflows");
  assert.match(text, /a file this pull request adds is shown whole in the diff/, "the gap is explained, not silent");
  assert.ok(!/### \.github\/workflows\/refresh-models\.yml/.test(text), "no fake base for the added file");
});

test("a directory that cannot be listed is named as a gap, not shown as empty", async () => {
  const api = { get: async () => { throw new Error("404"); } };
  const siblings = await siblingsOf(api, "o/r", "master", [{ filename: "src/new.js" }]);
  assert.equal(siblings.get("src"), null);
  const text = renderFacts({ context: new Map(), siblings, checks: "- Test: success" });
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
  const text = renderFacts({ context: new Map([["a.js", "  12  old a"], ["b.js", null]]), checks: "- Test: success", pr: "files changed: 2" });
  assert.match(text, /## Facts gathered for this review/);
  assert.match(text, /### code around the changes in a\.js, at the head commit/);
  assert.match(text, /12  old a/);
  assert.match(text, /### checks at the head commit\n- Test: success/);
  assert.match(text, /no surrounding code available for: b\.js/, "the file it could not read is named");
  assert.match(text, /nothing here is the result of running the code/);
  assert.ok(!/### b\.js/.test(text), "a null entry is not shown as if it had content");
});

test("no facts at all is no facts block, rather than an empty heading", () => {
  assert.equal(renderFacts({}), "");
  assert.equal(renderFacts({ context: new Map([["a.js", null]]) }), "", "a context of all nulls has nothing to show");
});

test("the pull request facts give its shape and leave the description to the prompt", () => {
  const facts = prFacts({ files: [{}, {}], baseRef: "main" });
  assert.match(facts, /base branch: main/);
  assert.match(facts, /files changed: 2/);
  assert.doesNotMatch(facts, /description/);
});

test("a repository that could not be read is named, not passed off as an all-clear", () => {
  const text = renderFacts({ context: null, checks: "- Test: success" });
  assert.match(text, /could not be read at all/);
});

test("a long excerpt is truncated and named as partial rather than filling the prompt", () => {
  const big = "x".repeat(90000);
  const text = renderFacts({ context: new Map([["a.js", big]]) });
  assert.match(text, /\.\.\. \(truncated\)/);
  assert.match(text, /only part of the surrounding code is shown for: a\.js/);
  assert.ok(text.length < 6000, `kept it to ${text.length} chars`);
});

test("the whole block is capped, so a wide pull request cannot overrun the model", () => {
  // The failure this prevents: a pull request touching many files sent more base
  // code than any pinned model can hold, and the request came back 400 on every
  // one of them, so the run failed having spent the whole rotation.
  const context = new Map(Array.from({ length: 60 }, (_, i) => [`src/f${i}.js`, "x".repeat(20000)]));
  const text = renderFacts({ context, checks: "- Test: success", pr: "files changed: 60", max_chars: 15000 });
  assert.ok(text.length <= 16000, `held it to ${text.length} chars against a 15000 budget`);
  assert.match(text, /### checks at the head commit/, "the checks survive the cap");
  assert.match(text, /### about this pull request/, "the description survives the cap");
});

test("a file the cap left out is named as a gap, not silently dropped", () => {
  const context = new Map(Array.from({ length: 40 }, (_, i) => [`src/f${i}.js`, "x".repeat(5000)]));
  const text = renderFacts({ context, max_chars: 4000 });
  assert.match(text, /left out of this review to keep the prompt within what the model can hold/);
  const named = text.match(/left out of this review[^;]*/)[0];
  assert.ok(named.includes("src/f"), "the paths it dropped are in the gaps line, so a cut file never reads as a clean one");
});

test("the cap is not a ceiling on a small pull request", () => {
  const context = new Map([["src/a.js", "old a"], ["src/b.js", "old b"]]);
  const text = renderFacts({ context, checks: "- Test: success", pr: "files changed: 2", max_chars: 15000 });
  assert.match(text, /### code around the changes in src\/a\.js, at the head commit/);
  assert.match(text, /### code around the changes in src\/b\.js, at the head commit/);
  assert.ok(!/left out of this review/.test(text), "nothing was cut, so nothing is named");
});
