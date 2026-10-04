import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { definitionsOf, downloadTree, headContext, identifiers, readFileAt, textsOf, windowOf } from "../src/lookup.js";

const tree = fileURLToPath(new URL("./fixtures/tree", import.meta.url));

test("a file is read from the tree, and a path outside it is refused", () => {
  assert.match(readFileAt(tree, "pkg/exceptions.py"), /class IncompleteRead/);
  assert.equal(readFileAt(tree, "pkg/missing.py"), null);
  assert.equal(readFileAt(tree, "../../../package.json"), null, "a path that climbs out of the tree is not read");
  assert.equal(readFileAt(tree, "escape.json"), null, "a symlink to a file outside the tree is not followed");
});

test("windowOf numbers the lines, marks gaps, and leaves out the lines to skip", () => {
  const texts = textsOf("a\nb\nc\nd\ne\nf\ng\nh");
  assert.equal(windowOf(texts, [2], 1), "     1  a\n     2  b\n     3  c");
  assert.equal(windowOf(texts, [1, 8], 1), "     1  a\n     2  b\n   ...\n     7  g\n     8  h");
  assert.equal(windowOf(texts, [2], 1, 1, new Set([2])), "     1  a\n   ...\n     3  c");
});

test("the code around a change is shown without the lines the diff already shows", () => {
  const patch = "@@ -29,3 +29,4 @@\n line29 = 29\n+added = 1\n line30 = 30\n line31 = 31";
  const out = headContext(tree, [{ filename: "pkg/handler.py", status: "modified", patch }]);
  const text = out.get("pkg/handler.py");
  assert.match(text, /line10 = 10/, "twenty lines above the added line");
  assert.doesNotMatch(text, /line9 = 9/);
  assert.doesNotMatch(text, /line31 = 31/, "a line the diff shows is left out");
  assert.match(text, /line50 = 50/, "twenty lines below it");
  assert.doesNotMatch(text, /line51 = 51/);
});

test("headContext lists only modified files it can read", () => {
  const patch = "@@ -1 +1 @@\n-x\n+y";
  const out = headContext(tree, [
    { filename: "pkg/handler.py", status: "modified", patch },
    { filename: "pkg/gone.py", status: "modified", patch },
    { filename: "pkg/new.py", status: "added", patch },
    { filename: "pkg/old.py", status: "removed", patch },
    { filename: "dist/a.js", status: "modified", patch },
  ], { ignore_paths: ["dist/"] });
  assert.deepEqual([...out.keys()], ["pkg/handler.py", "pkg/gone.py"]);
  assert.equal(out.get("pkg/gone.py"), null, "an unreadable file is null so the gap is named");
});

test("identifiers are the names a comment quotes in backticks", () => {
  assert.deepEqual(identifiers("`IncompleteRead` takes bytes, see `chunk.to_bytes()` and `actions/setup-python`"), ["IncompleteRead", "to_bytes"], "plain lowercase words are not names");
  assert.deepEqual(identifiers("Pass it to Python, then _incomplete_read gives IncompleteRead the wrong thing"), ["_incomplete_read", "IncompleteRead"], "a name that is not quoted is still a name, a capitalised word is not");
  assert.deepEqual(identifiers("no code here"), []);
  assert.equal(identifiers("`aa_1 bb_2 cc_3 dd_4`", 2).length, 2);
});

test("a name is found where it is declared, with the signature in view", () => {
  const [def] = definitionsOf(tree, ["IncompleteRead"]);
  assert.match(def, /### IncompleteRead, declared in pkg\/exceptions\.py/);
  assert.match(def, /def __init__\(self, partial: int, expected/, "the parameter type a comment would be checked against");
  const [constant] = definitionsOf(tree, ["MAX_REDIRECTS"]);
  assert.match(constant, /MAX_REDIRECTS = 10/);
  assert.deepEqual(definitionsOf(tree, ["NoSuchThing"]), []);
  assert.deepEqual(definitionsOf(tree, ["TransportError"]).length, 1, "a line that only uses the name is not its declaration");
});

// The tarball GitHub serves has one top-level folder holding the repository.
const tarball = () => spawnSync("tar", ["-czf", "-", "-C", fileURLToPath(new URL("./fixtures", import.meta.url)), "tree"], { maxBuffer: 1e6 }).stdout;

function serving(t, res) {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => res;
}

// The scratch directory is inside node_modules, which is ignored, so a run leaves nothing to commit and never touches the OS tmpdir.
const scratch = fileURLToPath(new URL("../node_modules/.scratch", import.meta.url));
const useScratch = (t) => {
  mkdirSync(scratch, { recursive: true });
  t.after(() => delete process.env.RUNNER_TEMP);
  process.env.RUNNER_TEMP = scratch;
};

test("the repository is downloaded without its top-level folder and can be read", async (t) => {
  useScratch(t);
  serving(t, new Response(tarball()));
  const dir = await downloadTree("token", "o/r", "abc");
  assert.match(readFileAt(dir, "pkg/exceptions.py"), /class IncompleteRead/);
});

test("a repository over the size limit, or a refused download, is an error and leaves nothing behind", async (t) => {
  useScratch(t);
  const before = readdirSync(scratch).length;
  serving(t, new Response(tarball()));
  await assert.rejects(downloadTree("token", "o/r", "abc", { maxBytes: 10 }), /too large/);
  serving(t, new Response("no", { status: 404 }));
  await assert.rejects(downloadTree("token", "o/r", "abc"), /tarball 404/);
  assert.equal(readdirSync(scratch).length, before, "the half-extracted tree is removed");
});

test("a name that is not an identifier is not searched for", () => {
  assert.deepEqual(definitionsOf(tree, ["IncompleteRead|.*", "a b"]), []);
});
