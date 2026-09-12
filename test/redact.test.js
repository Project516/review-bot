import { test } from "node:test";
import assert from "node:assert/strict";
import { redactor, tag } from "../src/redact.js";

test("hides the repo name anywhere it appears, case insensitively", () => {
  const hide = redactor(["Project516/secret-repo", "secret-repo", "Project516"]);
  assert.equal(hide("GET /repos/Project516/secret-repo/pulls/3 -> 404"), "GET /repos/[redacted]/pulls/3 -> 404");
  assert.equal(hide("cloned SECRET-REPO"), "cloned [redacted]");
});

test("ignores empty and short terms", () => {
  const hide = redactor([undefined, "", "ab", null]);
  assert.equal(hide("ab cd"), "ab cd");
});

test("tag is stable and does not contain the repo", () => {
  assert.equal(tag("a/b", 1), tag("a/b", 1));
  assert.notEqual(tag("a/b", 1), tag("a/b", 2));
  assert.match(tag("a/b", 1), /^[0-9a-f]{8}$/);
});
