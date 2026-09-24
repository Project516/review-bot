// Answers a reply on one of the bot's own inline review comments: read the
// thread, ask the model whether the concern still stands, post the reply,
// and when it is settled, resolve the thread and lift a CHANGES_REQUESTED
// review once every thread it raised is settled.
import { buildReplyMessages, parseReply } from "./prompt.js";
import { complete } from "./openrouter.js";

const SETTLED_MARKER = "<!-- review-bot settled -->";

// THREADS_QUERY is shared by review.js, which uses it to find already-settled
// points to keep out of a fresh review, and by reply.js, which uses it to
// find the thread a reply belongs to.
export const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
              author { login }
              body
              path
              line
              originalLine
              diffHunk
              pullRequestReview { databaseId }
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

export async function fetchThreads(graphql, repo, pr) {
  const [owner, name] = repo.split("/");
  const data = await graphql(THREADS_QUERY, { owner, name, number: pr });
  const node = data.repository.pullRequest;
  return { headRefOid: node.headRefOid, threads: node.reviewThreads.nodes };
}

// GraphQL reports a bot's login as the bare App slug; REST appends "[bot]".
// isGraphQLBot compares against the thread and mutation data, which is all
// GraphQL; isBot compares against REST data, namely the reviews list.
function isGraphQLBot(login, slug) {
  return typeof login === "string" && typeof slug === "string" && login.toLowerCase() === slug.toLowerCase();
}

export function isBot(login, slug) {
  return isGraphQLBot(login, `${slug}[bot]`);
}

// findThread locates the thread whose root comment is the one being replied to.
export function findThread(threads, rootId) {
  return threads.find((t) => t.comments.nodes[0]?.databaseId === rootId);
}

function latestComment(thread) {
  const nodes = thread.comments.nodes;
  return nodes[nodes.length - 1];
}

// botReplyCount counts the bot's own replies, not counting the root comment.
function botReplyCount(thread, slug) {
  return thread.comments.nodes.slice(1).filter((c) => isGraphQLBot(c.author?.login, slug)).length;
}

// isSettled is true once the bot's latest comment in the thread carries the
// marker, which survives a human toggling the thread's resolved state.
export function isSettled(thread, slug) {
  const last = latestComment(thread);
  return isGraphQLBot(last?.author?.login, slug) && last.body.includes(SETTLED_MARKER);
}

// skipReason says why a reply job should not get an answer, or null to proceed.
export function skipReason(thread, slug) {
  if (!thread) return "thread not found";
  const root = thread.comments.nodes[0];
  if (!isGraphQLBot(root.author?.login, slug)) return "root comment is not the bot's";
  if (isGraphQLBot(latestComment(thread).author?.login, slug)) return "bot already answered the latest comment";
  if (botReplyCount(thread, slug) >= 3) return "bot has replied 3 times already, leaving it for the owner";
  return null;
}

// latestBotReview picks the bot's most recent review that still counts,
// ignoring ones it dismissed or left pending. Reviews come back chronological.
export function latestBotReview(reviews, slug) {
  return reviews
    .filter((r) => isBot(r.user?.login, slug))
    .filter((r) => r.state !== "DISMISSED" && r.state !== "PENDING")
    .at(-1);
}

// shouldApprove decides whether settling `thread` clears the last
// CHANGES_REQUESTED review: that review must still apply to the current head,
// have no stray comments left over, and every thread it rooted must be
// settled, counting `thread` itself since its marker was just posted. review
// is REST data (`id`), threads are GraphQL (`databaseId`); the numbers match.
export function shouldApprove({ review, threads, thread, slug, headRefOid, postVerdicts }) {
  if (!postVerdicts) return { approve: false, reason: "post_verdicts is false" };
  if (!review) return { approve: false, reason: "no open review from the bot" };
  const root = thread.comments.nodes[0];
  if (root.pullRequestReview?.databaseId !== review.id) {
    return { approve: false, reason: "thread is not from the latest review" };
  }
  if (review.state !== "CHANGES_REQUESTED") return { approve: false, reason: `latest review state is ${review.state}` };
  if (review.commit_id !== headRefOid) return { approve: false, reason: "latest review predates the current head" };
  if (review.body?.includes("**Other notes**")) return { approve: false, reason: "latest review has stray comments outstanding" };
  const rooted = threads.filter((t) => t.comments.nodes[0]?.pullRequestReview?.databaseId === review.id);
  const unsettled = rooted.filter((t) => t.id !== thread.id && !isSettled(t, slug));
  if (unsettled.length) return { approve: false, reason: `${unsettled.length} other thread(s) from that review are not settled` };
  return { approve: true, reason: "all points from the last review are settled" };
}

export function footer(model, verdict, marker) {
  return `---\n<sub>review-bot, model ${model}, verdict ${verdict}</sub>\n${marker}`;
}

export async function reply({ api, job, cfg, log, slug, apiKey }) {
  const { headRefOid, threads } = await fetchThreads(api.graphql, job.repo, job.pr);
  const thread = findThread(threads, job.thread);
  const reason = skipReason(thread, slug);
  if (reason) {
    log(`reply: ${reason}`);
    return;
  }

  const root = thread.comments.nodes[0];
  const files = await api.paginate(`/repos/${job.repo}/pulls/${job.pr}/files`);
  const file = files.find((f) => f.filename === root.path);

  const { value, model } = await complete({
    apiKey,
    model: cfg.model,
    messages: buildReplyMessages({ pr: { number: job.pr, repo: job.repo }, thread, patch: file?.patch?.slice(0, cfg.max_diff_chars), slug }),
    accept: parseReply,
    log,
  });

  const marker = value.resolved ? `\n\n${SETTLED_MARKER}` : "";
  const body = `${value.reply}\n\n<sub>review-bot, model ${model}</sub>${marker}`;
  await api.post(`/repos/${job.repo}/pulls/${job.pr}/comments/${job.thread}/replies`, { body });
  log(`reply: posted, resolved=${value.resolved}`);
  if (!value.resolved) return;

  await api.graphql(RESOLVE_MUTATION, { id: thread.id }).catch((e) => log(`reply: resolve failed: ${e.message}`));

  const reviews = await api.paginate(`/repos/${job.repo}/pulls/${job.pr}/reviews`);
  const review = latestBotReview(reviews, slug);
  const decision = shouldApprove({ review, threads, thread, slug, headRefOid, postVerdicts: cfg.post_verdicts });
  if (!decision.approve) {
    log(`reply: not approving (${decision.reason})`);
    return;
  }

  const headMarker = `<!-- review-bot head=${headRefOid} -->`;
  await api.post(`/repos/${job.repo}/pulls/${job.pr}/reviews`, {
    commit_id: headRefOid,
    event: "APPROVE",
    body: `All points from the last review are settled in the threads.\n\n${footer(model, "approve", headMarker)}`,
  });
  log("reply: approved, settled review lifted");
}
