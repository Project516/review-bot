import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, waitFor, attemptsFor } from "../src/openrouter.js";

const reply = (content, extra = {}) =>
  new Response(JSON.stringify({ model: "m", choices: [{ message: { content }, ...extra }] }), { status: 200 });

function stub(responses) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return responses.shift();
  };
  return calls;
}

const run = (accept) => complete({ apiKey: "k", models: ["a", "b"], messages: [{ role: "user", content: "x" }], accept, backoff: 0, log: () => {} });

test("retries when the reply is not a review and nudges the next attempt", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const calls = stub([reply("user\nsafe"), reply("ok")]);
  const { value, model } = await run((text) => (text === "ok" ? { text } : null));
  assert.deepEqual(value, { text: "ok" });
  assert.equal(model, "m");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].messages.length, 1);
  assert.match(calls[1].messages.at(-1).content, /discarded/);
});

test("retries a truncated answer rather than accepting it", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  stub([reply("We are given a PR", { finish_reason: "length" }), reply("ok")]);
  const { value } = await run((text) => ({ text }));
  assert.deepEqual(value, { text: "ok" });
});

test("gives up loudly after the last attempt", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  stub([reply("no"), reply("no"), reply("no"), reply("no"), reply("no")]);
  await assert.rejects(run(() => null), /gave up after 5 attempts/);
});

test("does not retry a request the router rejected outright", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const calls = stub([new Response("bad key", { status: 401 })]);
  await assert.rejects(run(() => null), /OpenRouter 401/);
  assert.equal(calls.length, 1);
});

test("each attempt goes to the next model, and a missing model is stepped over", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const calls = stub([new Response("no such model", { status: 404 }), reply("no"), reply("ok")]);
  const { value } = await run((text) => (text === "ok" ? { text } : null));
  assert.deepEqual(value, { text: "ok" });
  assert.deepEqual(calls.map((c) => c.model), ["a", "b", "b"], "a 404 model is not asked again, the run moves on to the live one");
});

test("a model that is gone is not asked again, so the rotation keeps moving", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // "a" is 404, then "b" says something that is not a review, then "b" again
  // answers. "a" must not come back round: the run moves on to the live model.
  const calls = stub([new Response("gone", { status: 404 }), reply("no"), reply("ok")]);
  const { value } = await run((text) => (text === "ok" ? { text } : null));
  assert.deepEqual(value, { text: "ok" });
  assert.deepEqual(calls.map((c) => c.model), ["a", "b", "b"]);
});

test("a rate limit is not treated as the model being gone", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const calls = stub([new Response("slow down", { status: 429 }), reply("ok")]);
  await run(() => ({ ok: true }));
  assert.deepEqual(calls.map((c) => c.model), ["a", "b"], "a model that was rate limited is still live, so it comes round again");
});

test("a bad request does not retire the model, because the prompt is what is wrong", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // 400 is "invalid or missing params", so the same request would be rejected
  // by every model. Retiring "a" on that would lose a good model for a request
  // the next one will refuse too, so it only costs this attempt.
  const calls = stub([new Response("unsupported param", { status: 400 }), new Response("unsupported param", { status: 400 }), reply("ok")]);
  const { value } = await run((text) => (text === "ok" ? { text } : null));
  assert.deepEqual(value, { text: "ok" });
  assert.deepEqual(calls.map((c) => c.model), ["a", "b", "a"], "the 400 model comes back round, it was never written off");
});

test("the run reaches the router when every pin is gone from the catalog", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // Only 404 retires a model, so a pin that left the catalog steps aside and the
  // router is reached. The failure names the pins that are gone, which is the
  // thing worth reading in the log.
  const calls = stub([...Array(2).fill(0).map(() => new Response("no such model", { status: 404 })), ...Array(4).fill(0).map(() => new Response("slow down", { status: 429 }))]);
  await assert.rejects(
    complete({ apiKey: "k", models: ["a", "b", "openrouter/free"], messages: [{ role: "user", content: "x" }], accept: () => null, backoff: 0, log: () => {} }),
    /gone from the free list \(a, b\)/,
  );
  assert.deepEqual(calls.map((c) => c.model), ["a", "b", "openrouter/free", "openrouter/free", "openrouter/free", "openrouter/free"], "the router is reached after the gone pins and is never written off, and the reserve retries it");
});

test("the failure reports the attempts actually made, not the allowance", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // Four names, every one 404, so the run stops after four requests even though
  // the budget was larger. The message has to say four.
  const calls = stub(Array.from({ length: 10 }, () => new Response("gone", { status: 404 })));
  await assert.rejects(
    complete({ apiKey: "k", models: ["a", "b", "c", "openrouter/free"], messages: [{ role: "user", content: "x" }], accept: () => null, backoff: 0, log: () => {} }),
    /gave up after 4 attempts/,
  );
  assert.equal(calls.length, 4, "it stopped as soon as there was nothing left to try");
});

test("a run with nothing to try fails before it spends an attempt", async () => {
  await assert.rejects(complete({ apiKey: "k", models: [], messages: [], accept: (t) => t }), /no models to try/);
});

test("a model gated to a harness is skipped, not treated as a dead key", async (t) => {
  // The exact answer OpenRouter gives for a model only available inside an
  // agentic harness. The message names a harness, which makes it a fact about
  // that one model. Treating it as fatal abandoned a real review, and the log
  // ended on a 403 that read like a permissions problem with the key.
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const calls = stub([
    new Response(JSON.stringify({ error: { message: "thinkingmachines/inkling:free is only available on agentic harnesses." } }), { status: 403 }),
    reply("ok"),
  ]);
  const { value } = await run((text) => (text === "ok" ? { text } : null));
  assert.deepEqual(value, { text: "ok" });
  assert.equal(calls.length, 2);
});

test("an empty balance still throws, because that is the account not the model", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const calls = stub([new Response("insufficient credits", { status: 402 })]);
  await assert.rejects(run(() => null), /OpenRouter 402/);
  assert.equal(calls.length, 1);
});

test("the budget is a pass over the rotation plus a reserve, not a single pass", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // The run that lost a review: a rotation of five names, one gone from the free
  // list, one rate limited, and the router back empty. A budget of one pass
  // spent all five and posted nothing, because the router's empty answer was the
  // last one there was.
  const calls = stub([
    new Response("gone", { status: 404 }),
    new Response("slow down", { status: 429 }),
    reply("We are given a PR", { finish_reason: "length" }),
    reply("still thinking", { finish_reason: "length" }),
    // The router, spending its whole budget on reasoning and handing back
    // nothing. This is the answer that ended the run.
    new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "" } }] }), { status: 200 }),
    reply("ok"),
  ]);
  const { value } = await complete({
    apiKey: "k",
    models: ["a", "b", "c", "d", "openrouter/free"],
    messages: [{ role: "user", content: "x" }],
    accept: (text) => (text === "ok" ? { text } : null),
    backoff: 0,
    log: () => {},
  });
  assert.deepEqual(value, { text: "ok" });
  assert.equal(calls.length, 6, "the reserve is what paid for the sixth attempt");
});

test("a live model comes round again once the rotation has been spent", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // Every name answers, none of them with a review, and the run still gets a
  // second pass at the pins rather than ending the moment the list runs out.
  const calls = stub([...Array(8).fill(0).map(() => reply("not a review"))]);
  await assert.rejects(
    complete({ apiKey: "k", models: ["a", "b", "openrouter/free"], messages: [{ role: "user", content: "x" }], accept: () => null, backoff: 0, log: () => {} }),
    /gave up after 6 attempts/,
  );
  assert.deepEqual(calls.map((c) => c.model), ["a", "b", "openrouter/free", "a", "b", "openrouter/free"]);
});

test("the answer gets room for what a reasoning model spends thinking", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // Excluding the trace from the content does not stop the tokens being spent, so
  // a budget a reasoning model can fill on its own comes back empty and the run
  // counts a working model as a failure. 8000 was small enough to do that.
  const calls = stub([reply("ok")]);
  await complete({ apiKey: "k", models: ["a"], messages: [{ role: "user", content: "x" }], accept: (t) => t, backoff: 0, log: () => {} });
  assert.equal(calls[0].max_tokens, 24000);

  const overridden = stub([reply("ok")]);
  await complete({ apiKey: "k", models: ["a"], messages: [], accept: (t) => t, backoff: 0, maxTokens: 4096, log: () => {} });
  assert.equal(overridden[0].max_tokens, 4096, "and the config can still turn it down");
});

test("a long rotation does not spend the job's whole budget asleep", () => {
  // The rotation is however many pins and runners-up the config holds, so the
  // wait between attempts has to stay bounded or the job is killed by its own
  // timeout before it ever reaches the router at the end.
  const rotation = 12;
  const tries = attemptsFor(Array.from({ length: rotation }, (_, i) => `m${i}`));
  const total = Array.from({ length: tries }, (_, i) => waitFor(i, 15000)).reduce((a, b) => a + b, 0);
  // Twelve names is a longer rotation than the free list has produced. The
  // reserve is deliberately small: a measured call on a busy free model ran past
  // a minute, so an unbounded budget trades a lost review for a killed job.
  assert.ok(total < 5 * 60 * 1000, `${Math.round(total / 60000)} min of sleep leaves no room for the calls`);
  assert.equal(waitFor(0, 15000), 0, "the first attempt does not wait");
  assert.equal(waitFor(1, 15000), 15000, "it still backs off rather than hammering the endpoint");
  assert.equal(waitFor(99, 15000), 20000, "and it stops growing");
});

test("attemptsFor leaves a reserve without turning a short rotation into a long one", () => {
  assert.equal(attemptsFor(["a"]), 5, "a one name rotation still gets the floor");
  assert.equal(attemptsFor(["a", "b", "c", "d", "openrouter/free"]), 8, "the five name rotation that lost a review now has three in hand");
  assert.equal(attemptsFor(Array.from({ length: 11 }, (_, i) => `m${i}`)), 14, "and a longer one grows by the reserve, not by doubling");
});
