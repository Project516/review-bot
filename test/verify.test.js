import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { verify } from "../src/verify.js";

const tree = fileURLToPath(new URL("./fixtures/tree", import.meta.url));
const cfg = { models: ["m/a:free"], model_runners_up: [], ignore_paths: [] };
const files = [{ filename: "pkg/handler.py", status: "modified", patch: "@@ -1,2 +1,2 @@\n line1 = 1\n+line2 = 2" }];
const comments = [
  { path: "pkg/handler.py", line: 2, body: "`IncompleteRead` takes bytes" },
  { path: "pkg/handler.py", line: 1, body: "something real" },
];

function run(keep, seen = {}) {
  return async ({ messages, accept, attempts }) => {
    seen.messages = messages;
    seen.attempts = attempts;
    return { value: accept(JSON.stringify({ comments: keep.map((k, id) => ({ id, keep: k })) })), model: "m" };
  };
}

test("a comment the audit rejects is dropped and the rest are kept in order", async () => {
  const seen = {};
  const kept = await verify({ comments, files, dir: tree, cfg, apiKey: "k", log() {}, run: run([false, true], seen) });
  assert.deepEqual(kept, [comments[1]]);
  assert.equal(seen.attempts, 3, "the audit is a short job and does not spend the whole rotation");
});

test("the audit is shown the declaration of a name a comment quotes, and the code at the line", async () => {
  const seen = {};
  await verify({ comments, files, dir: tree, cfg, apiKey: "k", log() {}, run: run([true, true], seen) });
  const user = seen.messages[1].content;
  assert.match(user, /def __init__\(self, partial: int/);
  assert.match(user, /line2 = 2/, "the head file's own text at the line");
});

test("without a tree the audit still runs, from the patch, with no declarations", async () => {
  const seen = {};
  await verify({ comments, files, dir: null, cfg, apiKey: "k", log() {}, run: run([true, true], seen) });
  assert.match(seen.messages[1].content, /line2 = 2/);
  assert.match(seen.messages[1].content, /no declarations were found/);
});

test("an audit that no model could produce is an error for the caller to handle", async () => {
  const run = async () => { throw new Error("gave up"); };
  await assert.rejects(verify({ comments, files, dir: tree, cfg, apiKey: "k", log() {}, run }), /gave up/);
});
