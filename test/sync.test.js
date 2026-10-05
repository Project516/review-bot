import { test } from "node:test";
import assert from "node:assert/strict";
import { isSyncBranch, syncDiff, syncPrompt } from "../src/sync.js";
import { settleVerdict } from "../src/diff.js";
import { buildMessages } from "../src/prompt.js";
import { footer } from "../src/reply.js";

const UP = "u".repeat(40);
const HEAD = "h".repeat(40);
const cfg = { sync_branch_prefixes: ["sync/"], ignore_paths: ["*.lock"] };
const pr = { head: { ref: "sync/lib-1.2", sha: HEAD, repo: { full_name: "me/fork" } }, base: { repo: { full_name: "me/fork" } } };
const file = (filename, extra = {}) => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x", ...extra });

// A fake API keyed by path, counting calls.
function fakeApi({ parents = [{ sha: "b".repeat(40) }, { sha: UP }], compare = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(path);
      if (path.includes("/commits/")) return { parents };
      if (fail) throw new Error("compare down");
      return { files: compare };
    },
  };
}

test("a merge head on a sync branch reads only the PR files that differ from upstream", async () => {
  const api = fakeApi({ compare: [file("src/patched.js"), file("src/other.js")] });
  const prFiles = [file("src/patched.js"), file("src/upstream-only.js")];
  const sync = await syncDiff({ api, base: "/repos/me/fork", pr, prFiles, cfg });
  assert.deepEqual(sync.files.map((f) => f.filename), ["src/patched.js"]);
  assert.equal(sync.empty, false);
  assert.equal(sync.upstream, UP);
  assert.match(api.calls[1], new RegExp(`compare/${UP}\\.\\.\\.${HEAD}`));
  assert.match(sync.note, /only the fork's own changes on top of upstream commit uuuuuuu/);
});

test("an empty reduced diff is a clean merge that approves", async () => {
  const api = fakeApi({ compare: [file("src/fork-only.js")] });
  const sync = await syncDiff({ api, base: "/repos/me/fork", pr, prFiles: [file("src/a.js"), file("src/b.js")], cfg });
  assert.equal(sync.empty, true);
  assert.deepEqual(sync.files, []);
  assert.match(sync.note, /nothing fork-specific to review/);
  const outcome = settleVerdict({ verdict: "approve", kept: [], open: 0, complete: true });
  assert.equal(outcome.verdict, "approve");
  assert.equal(settleVerdict({ verdict: "approve", kept: [], open: 2 }).verdict, "comment", "open threads still block");
});

test("only ignored files left counts as nothing to review", async () => {
  const api = fakeApi({ compare: [file("pnpm.lock")] });
  const sync = await syncDiff({ api, base: "/repos/me/fork", pr, prFiles: [file("pnpm.lock")], cfg });
  assert.equal(sync.empty, true);
});

test("a head that is not a merge commit is reviewed normally", async () => {
  const api = fakeApi({ parents: [{ sha: "b".repeat(40) }] });
  assert.equal(await syncDiff({ api, base: "/r", pr, prFiles: [file("a.js")], cfg }), null);
  assert.equal(api.calls.length, 1, "no compare call");
});

test("a branch outside the prefix list is reviewed normally without any call", async () => {
  const api = fakeApi();
  const other = { ...pr, head: { ...pr.head, ref: "feature/x" } };
  assert.equal(await syncDiff({ api, base: "/r", pr: other, prFiles: [], cfg }), null);
  assert.equal(await syncDiff({ api, base: "/r", pr, prFiles: [], cfg: { ignore_paths: [] } }), null, "no prefixes configured");
  assert.equal(api.calls.length, 0);
});

test("a branch from another repo is reviewed normally", async () => {
  const api = fakeApi();
  const forked = { ...pr, head: { ...pr.head, repo: { full_name: "someone/fork" } } };
  assert.equal(await syncDiff({ api, base: "/r", pr: forked, prFiles: [], cfg }), null);
  assert.equal(api.calls.length, 0);
});

test("a failing compare falls back to normal review, never an approval", async () => {
  const api = fakeApi({ fail: true });
  const logs = [];
  assert.equal(await syncDiff({ api, base: "/r", pr, prFiles: [file("a.js")], cfg, log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /reviewing normally/);
});

test("a compare list that may be cut off is not trusted", async () => {
  const many = Array.from({ length: 100 }, (_, i) => file(`f${i}.js`));
  const api = fakeApi({ compare: many });
  assert.equal(await syncDiff({ api, base: "/r", pr, prFiles: many, cfg }), null);
});

test("isSyncBranch matches prefixes and ignores empty ones", () => {
  assert.equal(isSyncBranch("sync/x", ["sync/"]), true);
  assert.equal(isSyncBranch("resync/x", ["sync/"]), false);
  assert.equal(isSyncBranch("sync/x", [""]), false);
  assert.equal(isSyncBranch("sync/x"), false);
});

test("the sync note goes into the prompt and the prompt stays small", () => {
  const base = { number: 1, title: "t", body: "", changed_files: 1, additions: 1, deletions: 0, head: { ref: "sync/x" }, base: { ref: "main", repo: { full_name: "me/fork" } } };
  const args = { pr: base, diffText: "diff", omitted: [] };
  const plain = buildMessages(args)[1].content;
  const withSync = buildMessages({ ...args, sync: syncPrompt({ upstream: UP }) })[1].content;
  assert.match(withSync, /do not comment on it/);
  assert.ok(withSync.length - plain.length < 500);
});

test("a review with no model says so in the footer", () => {
  assert.equal(footer(null, "approve", "<!-- m -->"), "---\n<sub>review-bot, no model run, verdict approve</sub>\n<!-- m -->");
});
