// Entry point for the Actions job. Reads the job the Worker dispatched,
// applies reviewbot.json, and posts one review on the PR, or, for a reply
// job, hands off to reply.js.
import { readFileSync } from "node:fs";
import { loadConfig, requireEnv } from "./config.js";
import { decide } from "./policy.js";
import { client, installationToken, appSlug, GitHubError } from "./github.js";
import { renderDiff, validLines, splitComments } from "./diff.js";
import { buildMessages, parseReview } from "./prompt.js";
import { complete } from "./openrouter.js";
import { redactor } from "./log.js";
import { reply, fetchThreads, isSettled, footer } from "./reply.js";

// Set once the job is parsed, so the top-level failure handler can scrub too.
let scrub = String;

// Every job runs on a token without Contents write. Only resolving a review
// thread needs it, so that one call gets its own short-lived token.
const JOB_PERMISSIONS = { contents: "read", issues: "write", pull_requests: "write", checks: "read" };
const RESOLVE_PERMISSIONS = { contents: "write", pull_requests: "write" };
const RESOLVE_MUTATION = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

const VERDICT_EVENT = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" };

// readJob takes EVENT_JSON when set, for a run by hand, and otherwise the
// repository_dispatch payload from the file Actions writes to GITHUB_EVENT_PATH.
function readJob() {
  if (process.env.EVENT_JSON) return JSON.parse(process.env.EVENT_JSON);
  return JSON.parse(readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8")).client_payload;
}

async function main() {
  const job = readJob();
  const cfg = loadConfig();
  const log = install(job);
  log(`job: ${job.event} ${job.action} on ${job.ref ?? "<repo>"}#${job.pr}`);

  const decision = decide(job, cfg);
  log(`decision: ${decision.review ? "review" : "skip"} (${decision.reason})`);
  if (!decision.review) return;

  const appId = requireEnv("APP_ID");
  const privateKey = requireEnv("APP_PRIVATE_KEY");
  const token = await installationToken(appId, privateKey, job.installation, JOB_PERMISSIONS);
  const api = client(token);
  const base = `/repos/${job.repo}`;

  if (decision.reply) {
    const slug = await appSlug(appId, privateKey);
    const resolveThread = async (id) => {
      const writer = client(await installationToken(appId, privateKey, job.installation, RESOLVE_PERMISSIONS));
      await writer.graphql(RESOLVE_MUTATION, { id });
    };
    await reply({ api, job, cfg, log, slug, resolveThread, apiKey: requireEnv("OPENROUTER_API_KEY") });
    return;
  }

  // The eyes reaction only applies to a /review issue comment; a reply job's
  // comment_id names a review comment, not an issue comment, and is handled above.
  if (job.comment_id) {
    await api.post(`${base}/issues/comments/${job.comment_id}/reactions`, { content: "eyes" }).catch((e) => log(`reaction failed: ${e.message}`));
  }

  const pr = await api.get(`${base}/pulls/${job.pr}`);
  const marker = `<!-- review-bot head=${pr.head.sha} -->`;
  if (!decision.forced) {
    const reviews = await api.paginate(`${base}/pulls/${job.pr}/reviews`);
    if (reviews.some((r) => r.body?.includes(marker))) {
      log(`already reviewed ${pr.head.sha}, skipping`);
      return;
    }
  }

  const files = await api.paginate(`${base}/pulls/${job.pr}/files`);
  const diff = renderDiff(files, cfg);
  if (!diff.text) {
    log("no reviewable text diff, skipping");
    return;
  }

  let settled = [];
  try {
    const slug = await appSlug(appId, privateKey);
    const { threads } = await fetchThreads(api.graphql, job.repo, job.pr);
    settled = threads
      .filter((t) => isSettled(t, slug))
      .map((t) => ({ path: t.comments.nodes[0].path, body: t.comments.nodes[0].body }));
  } catch (e) {
    log(`settled points unavailable, reviewing without them: ${e.message}`);
  }

  const { value: review, model } = await complete({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    models: cfg.models,
    messages: buildMessages({ pr, diffText: diff.text, omitted: diff.omitted, settled }),
    accept: parseReview,
    log,
  });
  log(`model ${model} returned ${review.comments.length} comments, verdict ${review.verdict}`);

  const valid = new Map(files.map((f) => [f.filename, validLines(f.patch)]));
  const { inline, stray, dropped } = splitComments(review.comments, valid, review.verdict);
  if (dropped) log(`approve: dropped ${dropped} comments`);

  const body = (extra) => [review.summary, extra.length ? `**Other notes**\n${extra.map(fmtStray).join("\n")}` : "", footer(model, review.verdict, marker)].filter(Boolean).join("\n\n");
  const event = cfg.post_verdicts ? VERDICT_EVENT[review.verdict] : "COMMENT";

  try {
    await api.post(`${base}/pulls/${job.pr}/reviews`, { commit_id: pr.head.sha, event, body: body(stray), comments: inline });
    log(`posted review: ${inline.length} inline, ${stray.length} in body`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422) || inline.length === 0) throw e;
    log(`inline comments rejected (${e.message}), posting body only`);
    await api.post(`${base}/pulls/${job.pr}/reviews`, { commit_id: pr.head.sha, event, body: body([...inline, ...stray]) });
  }
}

function install(job) {
  const r = redactor(job);
  scrub = r.scrub;
  return r.log;
}

const fmtStray = (c) => `- \`${c.path}\`${Number.isFinite(c.line) ? `:${c.line}` : ""}: ${c.body}`;

main().catch((e) => {
  console.error(scrub(e?.stack ?? e));
  process.exit(1);
});
