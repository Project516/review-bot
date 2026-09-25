import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, planPins, compare, rotate, renderReport, renderPins, parseCatalog, settings, ROUTER, carryOverNotes, withNotes, NOTES_HEADING } from "../src/models.js";

// A catalog row shaped like the real one. score is the published coding index,
// ctx and out the room to work.
const model = (id, { score = 50, ctx = 262144, out = 32768, free = true, text = true, expiration = null } = {}) => ({
  id: free ? `${id}:free` : id,
  context_length: ctx,
  architecture: { input_modalities: text ? ["text"] : ["image"], output_modalities: ["text"] },
  pricing: { prompt: free ? 0 : 3, completion: free ? 0 : 15 },
  top_provider: { max_completion_tokens: out },
  benchmarks: score == null ? {} : { artificial_analysis: { coding_index: score, agentic_index: score / 2, intelligence_index: score / 3 } },
  expiration_date: expiration,
});

test("ranks the free models that can actually review a PR, best coding score first", () => {
  const { ranked, rejected, free } = rank([
    model("a/weak", { score: 20 }),
    model("b/strong", { score: 70 }),
    model("c/middle", { score: 45 }),
    model("d/paid", { free: false, score: 99 }),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["b/strong:free", "c/middle:free", "a/weak:free"]);
  // A plain paid model is not a pin that went paid: its id never carried :free,
  // so it has nothing to report.
  assert.deepEqual(rejected, []);
  assert.equal(free, 3, "a paid model is not a free model");
});

test("leaves out a model with no published coding score, and says why", () => {
  const { ranked, rejected } = rank([model("a/unbenchmarked", { score: null }), model("b/scored", { score: 40 })]);
  assert.deepEqual(ranked.map((r) => r.id), ["b/scored:free"]);
  assert.deepEqual(rejected, [{ id: "a/unbenchmarked:free", reason: "no published coding score" }]);
});

test("leaves out a model too small for a PR diff or a review", () => {
  const { ranked, rejected } = rank([
    model("a/tiny-context", { score: 90, ctx: 8192 }),
    model("b/tiny-output", { score: 90, out: 2048 }),
    model("c/fine", { score: 30 }),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["c/fine:free"]);
  assert.deepEqual(
    rejected.map((r) => `${r.id}: ${r.reason}`),
    ["a/tiny-context:free: context under 65536", "b/tiny-output:free: output cap under 16384"],
  );
});

test("leaves out an image-only model and an expired one", () => {
  const { ranked, rejected } = rank([
    model("a/vision-only", { score: 95, text: false }),
    model("b/expired", { score: 95, expiration: 1_700_000_000 }),
  ]);
  assert.deepEqual(ranked, []);
  assert.deepEqual(rejected.map((r) => r.reason).sort(), ["expired", "not a text model"]);
});

test("the order does not wobble when two models score the same", () => {
  const { ranked } = rank([model("b/twin", { score: 40 }), model("a/twin", { score: 40 })]);
  assert.deepEqual(ranked.map((r) => r.id), ["a/twin:free", "b/twin:free"]);
});

test("pins the top of the ranking and nothing more", () => {
  const { ranked } = rank([model("a", { score: 70 }), model("b", { score: 60 }), model("c", { score: 50 })]);
  assert.deepEqual(planPins(ranked), ["a:free", "b:free", "c:free"]);
  assert.deepEqual(planPins(ranked, { model_selection: { pin: 2 } }), ["a:free", "b:free"]);
  assert.equal(settings({ model_selection: { pin: 2 } }).pin, 2);
  assert.equal(settings({}).pin, 5, "the default number of pins");
});

test("a pin that left the free list is reported apart from one that ranked lower", () => {
  // Four ways a pin can stop being a pin, and the report has to tell them apart
  // because only two of them cost the reviewer an attempt:
  //
  //   c/repriced  still in the catalog, now costs money  -> gone
  //   d/vanished  not in the catalog at all              -> gone
  //   e/unscored  still free, but no published score     -> outranked
  //   f/small     still free, but too little context     -> outranked
  //
  // The last two are working models that simply did not make the cut. Filing
  // them under "no longer free" would tell a human to delete a model that is
  // fine, and would title the weekly PR "left the free list" about models that
  // are on it.
  // repriced keeps its :free id and loses its price, which is the only way a
  // pin can genuinely leave the free list.
  const repriced = model("c/repriced", { score: 70 });
  repriced.pricing = { prompt: "0.0005", completion: "0.0015" };
  const { ranked, rejected } = rank([
    model("a/stays", { score: 70 }),
    model("b/also-stays", { score: 60 }),
    repriced,
    model("e/unscored", { score: null }),
    model("f/small", { score: 65, ctx: 1024 }),
  ]);
  const change = compare(
    ["a/stays:free", "c/repriced:free", "d/vanished:free", "e/unscored:free", "f/small:free"],
    ranked,
    rejected,
    { model_selection: { pin: 2 } },
  );
  assert.deepEqual(change.desired, ["a/stays:free", "b/also-stays:free"]);
  assert.deepEqual(change.kept, ["a/stays:free"]);
  assert.deepEqual(change.added, ["b/also-stays:free"]);
  assert.deepEqual(change.gone, [
    { id: "c/repriced:free", reason: "no longer free" },
    { id: "d/vanished:free", reason: "no longer in the catalog" },
  ]);
  assert.deepEqual(change.outranked, [
    { id: "e/unscored:free", reason: "no published coding score" },
    { id: "f/small:free", reason: "context under 65536" },
  ]);
  assert.deepEqual(change.dropped, ["e/unscored:free", "f/small:free"], "they did fall out of the pins, which is not the same as being gone");
  assert.equal(change.changed, true);
});

test("the report tells a human not to delete a model that merely ranked out", () => {
  const { ranked, rejected } = rank([model("a/stays", { score: 70 }), model("b/low", { score: null })]);
  const change = compare(["a/stays:free", "b/low:free"], ranked, rejected, { model_selection: { pin: 1 } });
  const body = renderReport({ ranked, rejected, current: ["a/stays:free", "b/low:free"], change, cfg: { model_selection: { pin: 1 } }, free: 2 });
  assert.ok(body.includes("## Out of the pins this week"), body);
  assert.match(body, /Nothing to delete/, "the demoted model must not read as broken");
  assert.ok(!/## No longer free/.test(body), "a demotion is not a departure");
});

test("a ranking that matches the pins is not a change", () => {
  const { ranked, rejected } = rank([model("a", { score: 70 }), model("b", { score: 60 })]);
  const change = compare(["a:free", "b:free"], ranked, rejected);
  assert.equal(change.changed, false);
  assert.deepEqual(change.gone, []);
});

test("a run tries the pins in order, then the runners-up, and the router last", () => {
  const { ranked } = rank([model("a/pin", { score: 90 }), model("b/next", { score: 60 }), model("c/after", { score: 40 })]);
  const order = rotate(["a/pin:free", "b/next:free"], ranked);
  assert.deepEqual(order, ["a/pin:free", "b/next:free", "c/after:free", ROUTER]);
});

test("the router is only ever the last resort, and never a pin", () => {
  const order = rotate(["a:free"], []);
  assert.deepEqual(order, ["a:free", ROUTER]);
  assert.equal(order.at(-1), ROUTER);
  assert.ok(!rotate([ROUTER, "a:free"], [{ id: "b:free" }]).slice(0, -1).includes(ROUTER), "a pin never overrides the router");
  assert.equal(new Set(rotate(["a:free", "a:free"], [{ id: "a:free" }, { id: "b:free" }])).size, 3, "no name is tried twice");
});

test("the report names the order, the runners-up, the dead pins, and the leave-outs", () => {
  const { ranked, rejected, free } = rank([
    model("a/best", { score: 70 }),
    model("b/second", { score: 60 }),
    model("c/third", { score: 50 }),
    model("d/no-score", { score: null }),
  ]);
  const current = ["a/best:free", "x/departed:free"];
  const change = compare(current, ranked, rejected);
  const body = renderReport({ ranked, rejected, current, change, free, generated: "2026-09-25T07:17:00Z" });
  assert.match(body, /## Pinned/);
  assert.match(body, /- `a\/best:free`/);
  assert.match(body, /- `c\/third:free`/, "the runners-up are listed, they take over when a pin is gone");
  assert.match(body, /## No longer free[\s\S]*- `x\/departed:free`/);
  assert.match(body, /no published coding score[\s\S]*`d\/no-score:free`/);
  assert.match(body, /## Was pinned/);
  assert.match(body, /Fetched 2026-09-25/);
  assert.ok(!/[\u2014]/.test(body), "no em dashes");
});

test("the report says so when nothing on the free list qualifies", () => {
  const { ranked, rejected, free } = rank([model("a/tiny", { score: 90, ctx: 4096 })]);
  const change = compare([], ranked, rejected);
  const body = renderReport({ ranked, rejected, current: [], change, free });
  assert.match(body, /Nothing on the free list qualifies this week/);
  assert.match(body, /falls back to the free router/);
});

test("the catalog has to be a list of models", () => {
  assert.equal(parseCatalog({ data: [{ id: "a" }] }).length, 1);
  assert.equal(parseCatalog(JSON.stringify({ data: [{ id: "a" }] })).length, 1);
  assert.throws(() => parseCatalog({ error: "nope" }), /not a list of models/);
});

test("the pins are rewritten by parsing the config, not by matching a pattern", () => {
  // A key that looks like models but is not one must survive untouched, which is
  // what a regex over the file text would get wrong.
  const text = `${JSON.stringify({ prefs: { models: ["nested"] }, models: ["a:free", "b:free"], post_verdicts: true, ignore_paths: ["dist/"] }, null, 2)}\n`;
  const out = JSON.parse(renderPins(text, ["c:free"]));
  assert.deepEqual(out.models, ["c:free"], "the real pins were replaced");
  assert.deepEqual(out.prefs.models, ["nested"], "the nested key is not the pins and was left alone");
  assert.equal(out.post_verdicts, true, "the rest of the config survives");
  assert.deepEqual(out.ignore_paths, ["dist/"]);
});

test("writing the same pins leaves the file byte for byte alone", () => {
  const text = `${JSON.stringify({ models: ["a:free", "b:free"], post_verdicts: true }, null, 2)}\n`;
  assert.equal(renderPins(text, ["a:free", "b:free"]), text, "a week with no change writes nothing");
  assert.notEqual(renderPins(text, ["b:free", "a:free"]), text, "reordering is a change, since the order is the ranking");
  assert.equal(renderPins(text, ["a:free"]), renderPins(text, ["a:free"]), "and it is deterministic");
});

test("the config must be a JSON object, and a broken one is a loud failure", () => {
  assert.throws(() => renderPins("not json", ["a:free"]), /JSON/);
  assert.throws(() => renderPins("[1,2]", ["a:free"]), /not a JSON object/, "an array would stringify to something with no models key, dropping the pins");
  assert.throws(() => renderPins("null", ["a:free"]), /not a JSON object/);
  assert.equal(renderPins("{}", ["a:free"]), `${JSON.stringify({ models: ["a:free"] }, null, 2)}\n`, "an object with no models yet is fine, it gains one");
});

// The weekly job updates last week's PR in place, and a PR body update replaces
// the whole body. Without care, a note a human left on that PR is gone by the
// next run, and it is the one part of the body nobody automated wrote.

// oneReport is a real body off the real fixture shape, so these tests read the
// same text the weekly job would actually publish.
const oneReport = () => {
  const { ranked, rejected, free } = rank([model("a/best", { score: 70 }), model("b/second", { score: 60 }), model("c/third", { score: 50 })]);
  const current = ["a/best:free", "x/departed:free"];
  return renderReport({ ranked, rejected, current, change: compare(current, ranked, rejected), free, generated: "2026-09-25T07:17:00Z" });
};

test("a note a human left under its own heading survives the weekly update", () => {
  const previous = `${oneReport()}\n${NOTES_HEADING}\n\nHeld off on qwen, it was 429 all week.`;
  const notes = carryOverNotes(previous);
  assert.match(notes, /Held off on qwen/, notes);
  const next = withNotes(oneReport(), notes);
  assert.match(next, /## Pinned/, "this week's ranking is still there");
  assert.match(next, /Held off on qwen/, "and so is the note");
  assert.ok(next.indexOf("## Pinned") < next.indexOf(NOTES_HEADING), "the note sits below this week's ranking");
});

test("a body the human rewrote whole is kept whole", () => {
  // No bot section at all means a person replaced the body. Treating that as
  // stale bot output would throw away exactly the text that was written by hand.
  const previous = "I disagree with this order. Keeping the old pins until the rate limits settle.";
  assert.equal(carryOverNotes(previous), previous.trim());
});

test("a body with no human note carries nothing over", () => {
  assert.equal(carryOverNotes(oneReport()), null);
  assert.equal(carryOverNotes(""), null);
  assert.equal(carryOverNotes(null), null);
});

test("the bot never writes under the notes heading itself", () => {
  // If the bot's own output landed under NOTES_HEADING it would be carried over
  // as if a person had written it, and then pile up week after week.
  const report = oneReport();
  assert.ok(!report.includes(NOTES_HEADING), report);
});

test("the body says what the PR is and what to check before merging", () => {
  // The body is the only thing a human reads before deciding, so it has to
  // answer what this is and what a yes means, not just list model ids.
  const body = oneReport();
  assert.match(body, /## What this is/, body);
  assert.match(body, /## Before you merge/, body);
  assert.match(body, /reviewbot\.json/, "it names the one file that changes");
  assert.match(body, /never merged on its own/, "it says a human decides");
  assert.ok(!/[—]/.test(body), "no em dashes");
});

// Findings from the review the bot posted on this PR, each checked against the
// code before being fixed.

test("a pin that kept its :free id but stopped being free is reported as paid", () => {
  // rank() skips anything that is not free, so a pin whose provider repriced it
  // used to fall out of both lists and compare() called it "no longer in the
  // catalog". Those read as the same thing on the PR, and they are not: one is a
  // decision the provider made, the other is the model being retired.
  const stillFree = model("a/pin", { score: 70 });
  const repriced = model("x/repriced", { score: 80 });
  repriced.pricing = { prompt: "0.0005", completion: "0.0015" }; // keeps the id, loses the price
  const { ranked, rejected } = rank([stillFree, repriced]);
  assert.deepEqual(ranked.map((r) => r.id), ["a/pin:free"]);
  assert.deepEqual(rejected, [{ id: "x/repriced:free", reason: "no longer free" }]);
});

test("a paid model is not reported as a pin that went paid", () => {
  // Its id never ended in :free, so no pin can have pointed at it. Filing all
  // several hundred of those under "no longer free" buried the one that mattered:
  // a real run listed 400 of them and the actual answer was lost in the noise.
  const { rejected } = rank([model("a/pin", { score: 70 }), model("openai/something-paid", { free: false, score: 99 })]);
  assert.deepEqual(rejected, []);
});

test("a model with no published output cap is left out, not treated as unlimited", () => {
  // outputCap defaulted to Infinity here, so a model publishing no cap at all
  // passed the output-token threshold on the strength of a missing field.
  const noCap = model("a/nocap", { score: 90 });
  delete noCap.top_provider.max_completion_tokens;
  const { ranked, rejected } = rank([noCap]);
  assert.deepEqual(ranked, []);
  assert.match(rejected[0].reason, /output cap/);
});

test("the free count counts the free models, and a pin that went paid is named", () => {
  // The counter was named "free models" in the PR body while including models it
  // had just rejected, so the count and the "of them big enough" figure could not
  // both be describing the same set.
  const { ranked, rejected, free } = rank([
    model("a/good", { score: 70 }),
    model("b/also-good", { score: 60 }),
    model("c/tiny", { ctx: 1024 }),
  ]);
  assert.equal(free, 3, "all three are priced at zero, and all three count as free");
  assert.equal(ranked.length, 2, "one of them is too small to review a PR");
  assert.deepEqual(rejected, [{ id: "c/tiny:free", reason: "context under 65536" }]);
  const body = renderReport({ ranked, rejected, current: [], change: compare([], ranked, rejected), free });
  assert.match(body, /3 free models, 2 of them big enough/, body);
  assert.doesNotMatch(body, /cost money now/, "nothing here went paid yet");

  // The case the extra sentence was added for: a :free id that stopped being free.
  const repriced = model("d/repriced", { score: 95 });
  repriced.pricing = { prompt: "0.001", completion: "0.002" };
  const mixed = rank([model("a/good", { score: 70 }), repriced]);
  assert.deepEqual(mixed.rejected, [{ id: "d/repriced:free", reason: "no longer free" }]);
  const paidBody = renderReport({
    ranked: mixed.ranked,
    rejected: mixed.rejected,
    current: [],
    change: compare([], mixed.ranked, mixed.rejected),
    free: mixed.free,
  });
  assert.match(paidBody, /1 free models, 1 of them big enough to review a PR, \d+ pinned\. 1 more are listed but cost money now\./, paidBody);
});

test("the runners-up reach a review run instead of only the pins", () => {
  // rotate() has always accepted runners-up, but both call sites passed an empty
  // array, so the fallback after a pin died was the router and nothing else.
  const order = rotate(["a/pin:free", "b/pin:free"], ["c/spare:free", "d/spare:free"]);
  assert.deepEqual(order, ["a/pin:free", "b/pin:free", "c/spare:free", "d/spare:free", ROUTER]);
});
