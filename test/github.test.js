import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { client, appSlug, installationToken, GitHubError } from "../src/github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => (globalThis.fetch = original);
}

test("client.graphql posts the query and returns data", async () => {
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, "https://api.github.com/graphql");
    assert.deepEqual(JSON.parse(init.body), { query: "query", variables: { a: 1 } });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  });
  try {
    const data = await client("t").graphql("query", { a: 1 });
    assert.deepEqual(data, { ok: true });
  } finally {
    restore();
  }
});

test("client.graphql throws GitHubError on an HTTP error", async () => {
  const restore = stubFetch(async () => new Response("nope", { status: 401 }));
  try {
    await assert.rejects(client("t").graphql("query", {}), GitHubError);
  } finally {
    restore();
  }
});

test("client.graphql throws when the response carries errors", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ errors: [{ message: "bad field" }] }), { status: 200 }));
  try {
    await assert.rejects(client("t").graphql("query", {}), /bad field/);
  } finally {
    restore();
  }
});

test("appSlug reads the slug off GET /app", async () => {
  const restore = stubFetch(async (url) => {
    assert.match(String(url), /\/app$/);
    return new Response(JSON.stringify({ slug: "review-bot" }), { status: 200 });
  });
  try {
    assert.equal(await appSlug(1, pem), "review-bot");
  } finally {
    restore();
  }
});

test("installationToken sends permissions only when narrowing", async () => {
  const bodies = [];
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, "https://api.github.com/app/installations/7/access_tokens");
    bodies.push(init.body);
    return new Response(JSON.stringify({ token: "tok" }), { status: 201 });
  });
  try {
    assert.equal(await installationToken(1, pem, 7), "tok");
    assert.equal(await installationToken(1, pem, 7, { contents: "write" }), "tok");
    assert.deepEqual(bodies, [undefined, JSON.stringify({ permissions: { contents: "write" } })]);
  } finally {
    restore();
  }
});
