// The weekly job dispatches the test run on the branch it pushed, and takes that
// ref from the job rather than from a name written into the workflow. The
// workflow can only skip the dispatch when the job said nothing, so what this
// pins down is that a push says something and a week that pushed nothing stays
// quiet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPush } from "../src/refresh-models.js";

const outFile = () => join(mkdtempSync(join(tmpdir(), "dispatch-")), "out");

test("a push hands the workflow the ref to dispatch on", () => {
  // With the name typed into the workflow instead, a week whose ranking matched
  // the pins would still dispatch: the branch is the same string whether this
  // week wrote it or last week did. That is a test run against a commit nobody
  // is proposing, or a 404 that turns the weekly job red on a fresh install.
  const step = outFile();
  process.env.GITHUB_OUTPUT = step;
  try {
    recordPush();
  } finally {
    delete process.env.GITHUB_OUTPUT;
  }
  const written = readFileSync(step, "utf8");
  assert.match(written, /^ref=models\/weekly-pins$/m, `the ref is in the step output, got: ${JSON.stringify(written)}`);
});

test("a run outside Actions pushes no ref and does not fail", () => {
  // The weekly job is also run by hand for a dry run, where there is no step
  // output to write to. That has to be a quiet no-op rather than a crash after
  // the push has already landed.
  assert.equal(process.env.GITHUB_OUTPUT, undefined, "no step output in this environment");
  assert.doesNotThrow(() => recordPush());
});
