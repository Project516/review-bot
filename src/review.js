// Entry point for the Actions job. Reads the job the Worker dispatched,
// applies reviewbot.json, and posts one review on the PR, or, for a reply
// job, hands off to reply.js.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, requireEnv } from "./config.js";
import { decide } from "./policy.js";
import { client, installationToken, appSlug, GitHubError } from "./github.js";
import { renderDiff, validLines, splitComments, anchorByQuote } from "./diff.js";
import { buildMessages, parseReview } from "./prompt.js";
import { complete } from "./openrouter.js";
import { rotate } from "./models.js";
import { redactor } from "./log.js";
import { reply, fetchThreads, isSettled, isOpenPoint, footer, fetchChecks } from "./reply.js";
import { siblingsOf, checksBrief, prFacts, renderFacts } from "./facts.js";
import { downloadTree, headContext } from "./lookup.js";
import { verify } from "./verify.js";

// Set once the job is parsed, so the top-level failure handler can scrub too.
let scrub = String;

// Every job runs on a token without Contents write. Only resolving a review
// thread needs it, so that one call gets its own short-lived token.
const JOB_PERMISSIONS = { contents: "read", issues: "write", pull_requests: "write", checks: "read" };
const RESOLVE_PERMISSIONS = { contents: "write", pull_requests: "write" };
const RESOLVE_MUTATION = `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

const VERDICT_EVENT = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" };

// The run being read back is this job's own run in the review repo, which is
// not the repo under review, so it is named here rather than taken from the
// job.
const API_RUNS = () => `/repos/${process.env.GITHUB_REPOSITORY}/actions/runs`;

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
  // Asked here and again just before the post, and asked of a forced
  // review too. The marker says this head has been read already, and a
  // /review typed while the automatic review was still working is looking
  // at the same diff the automatic one is looking at, so the second one has
  // nothing to add. The gap between the two asks is one model call, which
  // is long enough for a competing run to finish and post in between.
  const alreadyReviewed = async () => {
    const reviews = await api.paginate(`${base}/pulls/${job.pr}/reviews`);
    return reviews.some((r) => r.body?.includes(marker));
  };
  if (await alreadyReviewed()) {
    log(`already reviewed ${pr.head.sha}, skipping`);
    return;
  }

  const files = await api.paginate(`${base}/pulls/${job.pr}/files`);
  const diff = renderDiff(files, cfg);
  if (!diff.text) {
    log("no reviewable text diff, skipping");
    return;
  }

  let settled = [];
  let open = [];
  try {
    const slug = await appSlug(appId, privateKey);
    const { threads } = await fetchThreads(api.graphql, job.repo, job.pr);
    const point = (t) => ({ path: t.comments.nodes[0].path, body: t.comments.nodes[0].body });
    settled = threads.filter((t) => isSettled(t, slug)).map(point);
    open = threads.filter((t) => isOpenPoint(t, slug)).map(point);
  } catch (e) {
    log(`earlier points unavailable, reviewing without them: ${e.message}`);
  }

  // The head commit, read once: the facts take the code around each change from
  // it and the check on the comments takes declarations from it.
  let tree = null;
  try {
    tree = await downloadTree(token, job.repo, pr.head.sha);
  } catch (e) {
    log(`repository unreadable at head, reviewing on the diff alone: ${e.message}`);
  }

  // The model sees a diff and nothing else, so a claim it cannot check from the
  // diff comes out as a guess. Hand it the code around each change at head, what
  // else sits beside the files it adds, and the check runs at head, so those
  // guesses stop.
  let facts = "";
  try {
    const context = tree ? headContext(tree, files, cfg) : null;
    const siblings = await siblingsOf(api, job.repo, pr.base.ref, files, cfg);
    const checks = checksBrief(await fetchChecks(api, job.repo, pr.head.sha, log));
    facts = renderFacts({ context, siblings, checks, pr: prFacts({ files, baseRef: pr.base.ref }), max_chars: cfg.max_facts_chars });
    const shown = [...(context?.values() ?? [])].filter(Boolean).length;
    log(`facts: ${shown} files with surrounding code, ${[...siblings.keys()].filter((k) => !k.endsWith("/")).length} folders listed, checks ${checks ? "read" : "unavailable"}`);
  } catch (e) {
    log(`facts unavailable, reviewing on the diff alone: ${e.message}`);
  }

  const { value: review, model } = await complete({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    models: rotate(cfg.models, cfg.model_runners_up ?? [], cfg),
    messages: buildMessages({ pr, diffText: diff.text, omitted: diff.omitted, cut: diff.cut, settled, open, facts }),
    accept: parseReview,
    maxTokens: cfg.max_output_tokens,
    log,
  });
  log(`model ${model} returned ${review.comments.length} comments, verdict ${review.verdict}`);

  const patches = new Map(files.map((f) => [f.filename, f.patch]));
  let comments = anchorByQuote(review.comments, patches);
  let unchecked = false;
  if (cfg.verify !== false && comments.length && review.verdict !== "approve") {
    try {
      comments = await verify({ comments, files, dir: tree, cfg, apiKey: requireEnv("OPENROUTER_API_KEY"), log });
    } catch (e) {
      unchecked = true;
      log(`verify failed, posting unchecked as a comment: ${e.message}`);
    }
  }

  const valid = new Map(files.map((f) => [f.filename, validLines(f.patch)]));
  const split = splitComments(comments, valid, unchecked && review.verdict === "request_changes" ? "comment" : review.verdict);
  const { inline, stray, dropped } = split;
  review.verdict = split.verdict;
  if (dropped) log(`approve: dropped ${dropped} comments`);

  const body = (extra) => [review.summary, extra.length ? `**Other notes**\n${extra.map(fmtStray).join("\n")}` : "", footer(model, review.verdict, marker)].filter(Boolean).join("\n\n");
  const event = cfg.post_verdicts ? VERDICT_EVENT[review.verdict] : "COMMENT";

  // Nothing has been published up to here, so this is the last cheap moment
  // to notice the run was superseded. A run that something replaced is
  // marked cancelled without the runner signalling node, so it used to carry
  // on and post a review several seconds after the run that replaced it had
  // already started. Reading the run back is the only barrier that works.
  if (await superseded()) {
    log("run was cancelled while the model worked, not posting");
    return;
  }
  if (await alreadyReviewed()) {
    log(`already reviewed ${pr.head.sha} while this run worked, not posting a second`);
    return;
  }

  try {
    await api.post(`${base}/pulls/${job.pr}/reviews`, { commit_id: pr.head.sha, event, body: body(stray), comments: inline });
    log(`posted review: ${inline.length} inline, ${stray.length} in body`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422) || inline.length === 0) throw e;
    log(`inline comments rejected (${e.message}), posting body only`);
    await api.post(`${base}/pulls/${job.pr}/reviews`, { commit_id: pr.head.sha, event, body: body([...inline, ...stray]) });
  }
}

// calledOff is what a run that has been superseded looks like. A cancelled run
// reports conclusion cancelled while status is still in_progress, because the
// runner is waiting on a process it never managed to signal, so conclusion alone
// is the case that actually happens.
export const calledOff = (run) => run?.status === "completed" || run?.conclusion === "cancelled";

// superseded reports whether this job's own run has already been called off.
// It reads the run with the workflow's token rather than the App's, so the
// App is not given actions: read it has no other use for.
async function superseded() {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId || !process.env.GITHUB_TOKEN) return false;
  try {
    const run = await client(process.env.GITHUB_TOKEN).get(`${API_RUNS()}/${runId}`);
    return calledOff(run);
  } catch (e) {
    // Unknowable is not cancelled, and failing closed here would cost a real
    // review over a transient API blip. The marker check is the backstop for
    // the duplicate this is really about.
    console.error(scrub(`run status unavailable: ${e.message}`));
    return false;
  }
}

function install(job) {
  const r = redactor(job);
  scrub = r.scrub;
  return r.log;
}

const fmtStray = (c) => `- \`${c.path}\`${Number.isFinite(c.line) ? `:${c.line}` : ""}: ${c.body}`;

// main runs on import only when this file is the entry point, so a test can
// import the helpers above without the job starting and reaching for a token.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(scrub(e?.stack ?? e));
    process.exit(1);
  });
}
