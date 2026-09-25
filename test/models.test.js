import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, planPins, compare, rotate, renderReport, parseCatalog, settings, ROUTER } from "../src/models.js";

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
  assert.equal(rejected.length, 0);
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
  // c/gone is still in the catalog but no longer free, d/vanished is gone from
  // the catalog entirely, and e/lower is free and fine, it just ranked out of
  // the top of the list.
  const { ranked, rejected } = rank([
    model("a/stays", { score: 70 }),
    model("b/also-stays", { score: 60 }),
    model("c/gone", { score: null }),
    model("e/lower", { score: 40 }),
  ]);
  const change = compare(["a/stays:free", "c/gone:free", "d/vanished:free", "e/lower:free"], ranked, rejected, { model_selection: { pin: 2 } });
  assert.deepEqual(change.desired, ["a/stays:free", "b/also-stays:free"]);
  assert.deepEqual(change.kept, ["a/stays:free"]);
  assert.deepEqual(change.added, ["b/also-stays:free"]);
  assert.deepEqual(change.gone, [
    { id: "c/gone:free", reason: "no published coding score" },
    { id: "d/vanished:free", reason: "no longer in the catalog" },
  ]);
  assert.deepEqual(change.dropped, ["e/lower:free"], "a model that is still free and merely ranked lower is not reported as gone");
  assert.equal(change.changed, true);
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
