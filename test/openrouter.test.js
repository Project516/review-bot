import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../src/openrouter.js";

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

test("the run is long enough to reach the router when every pin is dead", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  // Every pin is 404, and the router keeps answering 429, which is a limit that
  // clears, so it stays in the rotation and the run keeps trying it. The
  // failure names the pins that left the free list, which is the thing worth
  // reading in the log.
  const calls = stub([...Array(2).fill(0).map(() => new Response("gone", { status: 404 })), ...Array(3).fill(0).map(() => new Response("slow down", { status: 429 }))]);
  await assert.rejects(
    complete({ apiKey: "k", models: ["a", "b", "openrouter/free"], messages: [{ role: "user", content: "x" }], accept: () => null, backoff: 0, log: () => {} }),
    /gone from the free list \(a, b\)/,
  );
  assert.deepEqual(calls.map((c) => c.model), ["a", "b", "openrouter/free", "openrouter/free", "openrouter/free"], "the router is reached after the dead pins and is never written off");
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
