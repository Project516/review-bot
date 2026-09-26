// A run that something superseded used to keep going and publish. The workflow
// marks it cancelled, but the runner never signals node, so the job carried on
// and posted a review seconds after the run that replaced it had already
// started. What this pins down is the shape of that run, because the case that
// actually happens is the one a status check alone would miss.

import { test } from "node:test";
import assert from "node:assert/strict";
import { calledOff } from "../src/review.js";

test("a cancelled run is called off before its status flips", () => {
  // This is the shape the duplicate actually had. The runner is still waiting on
  // a process it never signalled, so status is in_progress and only conclusion
  // says the run is over. Checking status alone lets the review land.
  const run = { status: "in_progress", conclusion: "cancelled" };
  assert.equal(calledOff(run), true, "a cancelled conclusion is enough on its own");
});

test("a run that is over is called off whatever it concluded", () => {
  assert.equal(calledOff({ status: "completed", conclusion: "success" }), true);
  assert.equal(calledOff({ status: "completed", conclusion: "failure" }), true);
  assert.equal(calledOff({ status: "completed" }), true, "no conclusion yet is still over");
});

test("a live run is not called off", () => {
  // The whole point is to keep publishing reviews, so the ordinary case has to
  // stay false or nothing would ever be posted.
  assert.equal(calledOff({ status: "in_progress", conclusion: null }), false);
  assert.equal(calledOff({ status: "queued", conclusion: null }), false);
});

test("a run that could not be read is not treated as cancelled", () => {
  // Failing closed here would cost a real review over a transient API blip, and
  // the marker check is the backstop for the duplicate this is really about.
  assert.equal(calledOff(undefined), false);
  assert.equal(calledOff(null), false);
  assert.equal(calledOff({}), false);
});
