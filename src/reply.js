// Answers a reply on one of the bot's own inline review comments: read the
// thread, the diff and the check results at head, ask the model whether the
// concern still stands, post the reply, and when it is settled, resolve the
// thread and lift a CHANGES_REQUESTED review once every thread it raised is
// settled. The settled marker is the state that counts; a resolve that fails
// is logged and changes nothing else.
import { buildReplyMessages, parseReply } from "./prompt.js";
import { complete } from "./openrouter.js";
import { rotate } from "./models.js";
import { renderDiff } from "./diff.js";

const SETTLED_MARKER = "<!-- review-bot settled -->";
const HEAD_MARKER = "<!-- review-bot head=";

// THREADS_QUERY is shared by review.js, which uses it to find already-settled
// points to keep out of a fresh review, and by reply.js, which uses it to
// find the thread a reply belongs to.
export const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo { hasNextPage }
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

export async function fetchThreads(graphql, repo, pr) {
  const [owner, name] = repo.split("/");
  const data = await graphql(THREADS_QUERY, { owner, name, number: pr });
  const node = data.repository.pullRequest;
  const threads = node.reviewThreads.nodes;
  // Only the first page is fetched. truncated tells a caller the list is not
  // the whole story, so it must not approve on it.
  const truncated = node.reviewThreads.pageInfo.hasNextPage || threads.some((t) => t.comments.pageInfo?.hasNextPage);
  return { headRefOid: node.headRefOid, threads, truncated };
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
// ignoring ones it dismissed or left pending, and the empty COMMENTED reviews
// GitHub wraps each thread reply in: only a real review carries the head
// marker. Reviews come back chronological.
export function latestBotReview(reviews, slug) {
  return reviews
    .filter((r) => isBot(r.user?.login, slug) && r.body?.includes(HEAD_MARKER))
    .filter((r) => r.state !== "DISMISSED" && r.state !== "PENDING")
    .at(-1);
}

// shouldApprove decides whether settling `thread` clears the last
// CHANGES_REQUESTED review: that review must still apply to the current head,
// have no stray comments left over, and every thread it rooted must be
// settled, counting `thread` itself since its marker was just posted. review
// is REST data (`id`), threads are GraphQL (`databaseId`); the numbers match.
export function shouldApprove({ review, threads, thread, slug, headRefOid, postVerdicts, truncated = false }) {
  if (!postVerdicts) return { approve: false, reason: "post_verdicts is false" };
  if (truncated) return { approve: false, reason: "too many threads to check them all" };
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

// fetchChecks lists the first page of check runs on a commit as
// { runs: [{ name, status, conclusion }], more }, where more counts the runs
// past that page, or null when they cannot be read, so the model is told they
// are unknown rather than that nothing ran.
export async function fetchChecks(api, repo, sha, log) {
  try {
    const res = await api.get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    const runs = res.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
    return { runs, more: Math.max(0, res.total_count - runs.length) };
  } catch (e) {
    log(`reply: checks unavailable: ${e.message}`);
    return null;
  }
}

export async function reply({ api, job, cfg, log, slug, resolveThread, apiKey }) {
  const { headRefOid, threads } = await fetchThreads(api.graphql, job.repo, job.pr);
  const thread = findThread(threads, job.thread);
  const reason = skipReason(thread, slug);
  if (reason) {
    log(`reply: ${reason}`);
    return;
  }

  const root = thread.comments.nodes[0];
  const files = await api.paginate(`/repos/${job.repo}/pulls/${job.pr}/files`);
  // The commented file goes first so the diff budget never squeezes it out.
  const diff = renderDiff([...files].sort((a, b) => (b.filename === root.path) - (a.filename === root.path)), cfg);
  const checks = await fetchChecks(api, job.repo, headRefOid, log);

  const { value, model } = await complete({
    apiKey,
    models: rotate(cfg.models, [], cfg),
    messages: buildReplyMessages({ pr: { number: job.pr, repo: job.repo }, thread, diffText: diff.text, omitted: diff.omitted, checks, slug }),
    accept: parseReply,
    log,
  });

  const marker = value.resolved ? `\n\n${SETTLED_MARKER}` : "";
  // The model must not be able to mark a thread settled by writing the marker itself.
  const text = value.reply.replaceAll(SETTLED_MARKER, "").trim();
  const body = `${text}\n\n<sub>review-bot, model ${model}</sub>${marker}`;
  await api.post(`/repos/${job.repo}/pulls/${job.pr}/comments/${job.thread}/replies`, { body });
  log(`reply: posted, resolved=${value.resolved}`);
  if (!value.resolved) return;

  await resolveThread(thread.id).catch((e) => log(`reply: resolve failed: ${e.message}`));

  // Re-read after posting: a reply in another thread of the same review may
  // have settled it while the model was thinking.
  const fresh = await fetchThreads(api.graphql, job.repo, job.pr);
  const reviews = await api.paginate(`/repos/${job.repo}/pulls/${job.pr}/reviews`);
  const review = latestBotReview(reviews, slug);
  const decision = shouldApprove({ review, threads: fresh.threads, thread, slug, headRefOid: fresh.headRefOid, postVerdicts: cfg.post_verdicts, truncated: fresh.truncated });
  if (!decision.approve) {
    log(`reply: not approving (${decision.reason})`);
    return;
  }

  const headMarker = `<!-- review-bot head=${fresh.headRefOid} -->`;
  await api.post(`/repos/${job.repo}/pulls/${job.pr}/reviews`, {
    commit_id: fresh.headRefOid,
    event: "APPROVE",
    body: `All points from the last review are settled in the threads.\n\n${footer(model, "approve", headMarker)}`,
  });
  log("reply: approved, settled review lifted");
}
