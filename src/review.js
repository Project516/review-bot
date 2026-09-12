// Entry point for the Actions job. Reads the job the Worker dispatched from
// EVENT_JSON, applies reviewbot.json, and posts one review on the PR.
import { loadConfig, requireEnv } from "./config.js";
import { decide } from "./policy.js";
import { client, installationToken, GitHubError } from "./github.js";
import { renderDiff, validLines } from "./diff.js";
import { buildMessages, parseReview } from "./prompt.js";
import { complete } from "./openrouter.js";
import { redactor } from "./log.js";

// Set once the job is parsed, so the top-level failure handler can scrub too.
let scrub = String;

const VERDICT_EVENT = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" };

async function main() {
  const job = JSON.parse(requireEnv("EVENT_JSON"));
  const cfg = loadConfig();
  const log = install(job);
  log(`job: ${job.event} ${job.action} on ${job.ref ?? "<repo>"}#${job.pr}`);

  const decision = decide(job, cfg);
  log(`decision: ${decision.review ? "review" : "skip"} (${decision.reason})`);
  if (!decision.review) return;

  const token = await installationToken(requireEnv("APP_ID"), requireEnv("APP_PRIVATE_KEY"), job.installation);
  const api = client(token);
  const base = `/repos/${job.repo}`;

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

  const { text, model } = await complete({ apiKey: requireEnv("OPENROUTER_API_KEY"), model: cfg.model, messages: buildMessages({ pr, diffText: diff.text, omitted: diff.omitted }) });
  log(`model ${model} replied with ${text.length} chars`);
  const review = parseReview(text);

  const valid = new Map(files.map((f) => [f.filename, validLines(f.patch)]));
  const inline = [];
  const stray = [];
  for (const c of review.comments) {
    if (valid.get(c.path)?.has(c.line)) inline.push({ path: c.path, line: c.line, side: "RIGHT", body: c.body });
    else stray.push(c);
  }

  const footer = `---\n<sub>review-bot, model ${model}, verdict ${review.verdict}</sub>\n${marker}`;
  const body = (extra) => [review.summary, extra.length ? `**Other notes**\n${extra.map(fmtStray).join("\n")}` : "", footer].filter(Boolean).join("\n\n");
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
