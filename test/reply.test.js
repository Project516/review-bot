import { test } from "node:test";
import assert from "node:assert/strict";
import { isBot, findThread, isSettled, isOpenPoint, staleRequests, skipReason, latestBotReview, shouldApprove, footer, fetchChecks } from "../src/reply.js";

const SLUG = "review-bot";
const bot = (login) => ({ login });

// Thread/comment data comes from GraphQL, which reports the bot's login as
// the bare slug (REST appends "[bot]", used only for the reviews list).
const comment = (over) => ({ databaseId: 1, author: bot(SLUG), body: "issue", path: "a.js", line: 1, ...over });

test("isBot matches the app's login case-insensitively, with the bot suffix", () => {
  assert.equal(isBot(`${SLUG}[bot]`, SLUG), true);
  assert.equal(isBot(`${SLUG.toUpperCase()}[BOT]`, SLUG), true);
  assert.equal(isBot("octocat", SLUG), false);
  assert.equal(isBot(undefined, SLUG), false);
});

test("findThread locates the thread rooted at the given comment id", () => {
  const threads = [{ comments: { nodes: [comment({ databaseId: 5 })] } }, { comments: { nodes: [comment({ databaseId: 9 })] } }];
  assert.equal(findThread(threads, 9), threads[1]);
  assert.equal(findThread(threads, 404), undefined);
});

test("isSettled is true only when the bot's latest comment carries the marker", () => {
  const settled = { comments: { nodes: [comment(), { databaseId: 2, author: bot(SLUG), body: "fixed\n\n<!-- review-bot settled -->" }] } };
  const notYet = { comments: { nodes: [comment(), { databaseId: 2, author: bot(SLUG), body: "still wrong" }] } };
  const humanLast = { comments: { nodes: [comment(), { databaseId: 2, author: bot(SLUG), body: "fixed\n\n<!-- review-bot settled -->" }, { databaseId: 3, author: bot("octocat"), body: "thanks" }] } };
  assert.equal(isSettled(settled, SLUG), true);
  assert.equal(isSettled(notYet, SLUG), false);
  assert.equal(isSettled(humanLast, SLUG), false);
});

test("skipReason rejects a missing thread, a human root, an already-answered thread, and a maxed-out thread", () => {
  assert.equal(skipReason(undefined, SLUG), "thread not found");

  const humanRoot = { comments: { nodes: [comment({ author: bot("octocat") })] } };
  assert.equal(skipReason(humanRoot, SLUG), "root comment is not the bot's");

  const answered = { comments: { nodes: [comment(), { databaseId: 2, author: bot(SLUG), body: "already replied" }] } };
  assert.equal(skipReason(answered, SLUG), "bot already answered the latest comment");

  const maxed = {
    comments: {
      nodes: [
        comment(),
        { databaseId: 2, author: bot(SLUG), body: "1" },
        { databaseId: 3, author: bot("octocat"), body: "still no" },
        { databaseId: 4, author: bot(SLUG), body: "2" },
        { databaseId: 5, author: bot("octocat"), body: "still no" },
        { databaseId: 6, author: bot(SLUG), body: "3" },
        { databaseId: 7, author: bot("octocat"), body: "last word" },
      ],
    },
  };
  assert.equal(skipReason(maxed, SLUG), "bot has replied 3 times already, leaving it for the owner");

  const fresh = { comments: { nodes: [comment(), { databaseId: 2, author: bot("octocat"), body: "reply" }] } };
  assert.equal(skipReason(fresh, SLUG), null);
});

test("latestBotReview ignores dismissed and pending reviews, reply wrappers and other users", () => {
  // Reviews come from REST, which appends "[bot]" to the App's login.
  const reviews = [
    { id: 1, user: bot(`${SLUG}[bot]`), state: "CHANGES_REQUESTED", body: "fix it\n<!-- review-bot head=abc -->" },
    { id: 2, user: bot("octocat"), state: "APPROVED", body: "" },
    { id: 3, user: bot(`${SLUG}[bot]`), state: "DISMISSED", body: "<!-- review-bot head=abc -->" },
    { id: 4, user: bot(`${SLUG}[bot]`), state: "PENDING", body: "<!-- review-bot head=abc -->" },
    // The wrapper GitHub creates around one of the bot's thread replies.
    { id: 5, user: bot(`${SLUG}[bot]`), state: "COMMENTED", body: "" },
  ];
  assert.equal(latestBotReview(reviews, SLUG).id, 1);
  assert.equal(latestBotReview([], SLUG), undefined);
});

test("shouldApprove requires the settled thread to belong to a current, unfinished review with no stray comments", () => {
  const thread = { id: "t1", comments: { nodes: [{ ...comment(), pullRequestReview: { databaseId: 100 } }] } };
  const otherThread = { id: "t2", comments: { nodes: [{ ...comment({ databaseId: 20 }), pullRequestReview: { databaseId: 100 } }] } };
  const review = { id: 100, state: "CHANGES_REQUESTED", commit_id: "sha1", body: "summary" };
  const base = { review, threads: [thread], thread, slug: SLUG, headRefOid: "sha1", postVerdicts: true };

  assert.equal(shouldApprove(base).approve, true);
  assert.equal(shouldApprove({ ...base, postVerdicts: false }).approve, false);
  assert.equal(shouldApprove({ ...base, truncated: true }).approve, false);
  assert.equal(shouldApprove({ ...base, review: undefined }).approve, false);
  assert.equal(shouldApprove({ ...base, review: { ...review, state: "APPROVED" } }).approve, false);
  assert.equal(shouldApprove({ ...base, headRefOid: "sha2" }).approve, false);
  assert.equal(shouldApprove({ ...base, review: { ...review, body: "summary\n\n**Other notes**\n- x" } }).approve, false);
  assert.equal(shouldApprove({ ...base, threads: [thread, otherThread] }).approve, false);
});

test("footer names the model, verdict and carries the marker", () => {
  assert.equal(footer("m/x", "approve", "<!-- review-bot head=sha -->"), "---\n<sub>review-bot, model m/x, verdict approve</sub>\n<!-- review-bot head=sha -->");
});

test("fetchChecks keeps name, status and conclusion, counts runs past the first page, and is null when the checks cannot be read", async () => {
  const api = {
    get: async (path) => {
      assert.equal(path, "/repos/o/r/commits/abc/check-runs?per_page=100");
      return { total_count: 101, check_runs: [{ name: "build", status: "completed", conclusion: "success", id: 9 }] };
    },
  };
  assert.deepEqual(await fetchChecks(api, "o/r", "abc", () => {}), { runs: [{ name: "build", status: "completed", conclusion: "success" }], more: 100 });
  const lines = [];
  const denied = { get: async () => { throw new Error("403"); } };
  assert.equal(await fetchChecks(denied, "o/r", "abc", (l) => lines.push(l)), null);
  assert.deepEqual(lines, ["reply: checks unavailable: 403"]);
});

test("an open point is a bot thread nobody has settled or resolved", () => {
  const settled = { comments: { nodes: [comment(), { databaseId: 2, author: bot(SLUG), body: "fixed\n\n<!-- review-bot settled -->" }] } };
  assert.equal(isOpenPoint({ isResolved: false, comments: { nodes: [comment()] } }, SLUG), true);
  assert.equal(isOpenPoint({ isResolved: true, comments: { nodes: [comment()] } }, SLUG), false);
  assert.equal(isOpenPoint({ isResolved: false, ...settled }, SLUG), false);
  assert.equal(isOpenPoint({ isResolved: false, comments: { nodes: [comment({ author: bot("octocat") })] } }, SLUG), false, "a human's thread is not the bot's point");
});

test("an earlier request for changes is lifted only when its own threads are settled and the head moved on", () => {
  const request = (id, over = {}) => ({ id, user: { login: `${SLUG}[bot]` }, state: "CHANGES_REQUESTED", commit_id: "old", ...over });
  const thread = (reviewId, over = {}) => ({ isResolved: false, comments: { nodes: [comment({ pullRequestReview: { databaseId: reviewId } })] }, ...over });
  const lift = (reviews, threads, extra = {}) => staleRequests({ reviews, threads, slug: SLUG, headSha: "new", ...extra }).map((r) => r.id);

  assert.deepEqual(lift([request(1)], [thread(1, { isResolved: true })]), [1]);
  assert.deepEqual(lift([request(1)], []), [1], "a request with no threads has nothing left to settle");
  assert.deepEqual(lift([request(1)], [thread(1)]), [], "an open thread from that review keeps it");
  assert.deepEqual(lift([request(1), request(2)], [thread(2), thread(1, { isResolved: true })]), [1], "a thread from another review does not block this one");
  assert.deepEqual(lift([request(1, { commit_id: "new" })], []), [], "a request on the current head is not stale");
  assert.deepEqual(lift([request(1, { state: "COMMENTED" })], []), []);
  assert.deepEqual(lift([request(1, { user: { login: "octocat" } })], []), [], "someone else's review is never touched");
  assert.deepEqual(lift([request(1)], [], { truncated: true }), [], "unknown threads are not assumed settled");
});
