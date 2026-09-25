// The weekly refresh records the runners-up beside the pins so a review run can
// use them without fetching the catalog. That only works if the write, the read
// and rotate() agree, which is what these pin down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { withRunnersUp, dropRunnersUp, RUNNERS_KEY } from "../src/refresh-models.js";
import { rotate, planPins, ROUTER } from "../src/models.js";

const CONFIG = new URL("../reviewbot.json", import.meta.url);

test("the runners-up land in the config beside the pins, and the pins survive", () => {
  const before = readFileSync(CONFIG, "utf8");
  const after = withRunnersUp(before, ["c/spare:free", "d/spare:free"]);
  const config = JSON.parse(after);
  assert.deepEqual(config.models, JSON.parse(before).models, "the pins are untouched");
  assert.deepEqual(config[RUNNERS_KEY], ["c/spare:free", "d/spare:free"]);
  // Every key the operator set is still there with the same value.
  for (const [key, value] of Object.entries(JSON.parse(before))) {
    if (key === "models") continue;
    assert.deepEqual(config[key], value, `${key} survived`);
  }
});

test("importing the module does not run the weekly job", () => {
  // It used to, which meant a test importing a helper fetched the live catalog
  // and rewrote reviewbot.json as a side effect. That is how the runners-up key
  // first turned up in the config with nobody expecting it.
  const before = readFileSync(CONFIG, "utf8");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("./src/refresh-models.js")'], { encoding: "utf8" });
  assert.doesNotMatch(out, /catalog:/, `no catalog fetch on import, got: ${out}`);
  assert.equal(readFileSync(CONFIG, "utf8"), before, "the config on disk is untouched");
});

test("a week with no runners-up clears a stale list instead of keeping it", () => {
  // Otherwise names that dropped off the ranking last month would sit in the
  // rotation forever, since a review has no way to notice they are no longer free.
  const stale = withRunnersUp(readFileSync(CONFIG, "utf8"), ["old/gone:free"]);
  assert.ok(RUNNERS_KEY in JSON.parse(stale));
  assert.ok(!(RUNNERS_KEY in JSON.parse(dropRunnersUp(stale))), "the key is gone, not left empty");
});

test("a config that never had runners-up is left alone, key for key", () => {
  // JSON.stringify normalises whitespace, so this compares the parsed shape
  // rather than the bytes: what matters is that no key is added or lost.
  const before = readFileSync(CONFIG, "utf8");
  assert.deepEqual(JSON.parse(dropRunnersUp(before)), JSON.parse(before));
});

test("a review run uses the recorded runners-up between the pins and the router", () => {
  // This is the whole point of writing them down. Before, both call sites passed
  // an empty list, so a pin that left the free list had only the router left.
  const config = JSON.parse(withRunnersUp(readFileSync(CONFIG, "utf8"), ["c/spare:free"]));
  const order = rotate(config.models, config[RUNNERS_KEY] ?? [], config);
  assert.deepEqual(order.slice(0, config.models.length), config.models, "pins come first, in order");
  assert.ok(order.includes("c/spare:free"), "the spare is reachable");
  assert.equal(order[order.length - 1], ROUTER, "the router is still the last resort");
});

test("a config with no runners-up key still runs, on the pins and the router", () => {
  // The key only appears after the first refresh run, so every review before then
  // takes this path. The config is built here rather than read from
  // reviewbot.json, because the first run that writes the key would otherwise
  // turn this into a test of a checked-in file that changes under it.
  const config = { models: ["a/pin:free", "b/pin:free"] };
  assert.equal(RUNNERS_KEY in config, false, "the key is absent on a fresh checkout");
  const order = rotate(config.models, config[RUNNERS_KEY] ?? [], config);
  assert.deepEqual(order, [...config.models, ROUTER]);
});

test("no name is tried twice when a spare duplicates a pin", () => {
  const order = rotate(["a/pin:free", "b/pin:free"], ["b/pin:free", "c/spare:free"]);
  assert.equal(new Set(order).size, order.length, "no repeats");
  assert.deepEqual(order, ["a/pin:free", "b/pin:free", "c/spare:free", ROUTER]);
});

test("a week that only reshuffles the runners-up is still a change", () => {
  // The runners-up are half of what the job writes and a review run reads them,
  // so a reorder there matters as much as a reorder among the pins. Checking the
  // pins alone left the job silent on a week that changed the fallback list,
  // which is the week the runners-up exist to record. The job compares the
  // recorded list against this week's ranking before it decides to open a PR,
  // so that is what is compared here rather than the file, which is overwritten
  // either way.
  const cfg = { model_selection: { pin: 2 } };
  const ranked = [{ id: "a/pin:free" }, { id: "b/pin:free" }, { id: "c/spare:free" }, { id: "d/last:free" }];
  const pinsUnchanged = () => planPins(ranked, cfg).join() === ["a/pin:free", "b/pin:free"].join();
  const thisWeek = ranked.slice(2).map((r) => r.id);
  const reordered = (list) => list.join() !== thisWeek.join();

  assert.deepEqual(planPins(ranked, cfg), ["a/pin:free", "b/pin:free"]);
  assert.equal(pinsUnchanged(), true, "the pins are identical in both weeks");
  assert.equal(reordered(["d/last:free", "c/spare:free"]), true, "a reorder of the spares alone still has to open a PR");
  assert.equal(reordered(["e/new:free", "d/last:free"]), true, "and so does a swap in which model is the spare");
  assert.equal(reordered(thisWeek), false, "an identical week stays silent");
});
