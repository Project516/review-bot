// Entry point for the Actions job. Reads the job the Worker dispatched from
// EVENT_JSON, applies reviewbot.json, and posts one review on the PR.
import { loadConfig, requireEnv } from "./config.js";
import { decide } from "./policy.js";
import { client, installationToken, GitHubError } from "./github.js";
import { renderDiff, validLines } from "./diff.js";
import { buildMessages, parseReview } from "./prompt.js";
import { complete } from "./openrouter.js";
import { installRedaction, tag } from "./redact.js";

const VERDICT_EVENT = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" };

async function main() {
  const job = JSON.parse(requireEnv("EVENT_JSON"));
  const cfg = loadConfig();
  // This repo is public, so its Actions logs are too. Everything below is
  // written as if a stranger were reading it.
  installRedaction([job.repo, job.repo?.split("/")[1], job.author, job.sender]);
  console.log(`job ${tag(job.repo, job.pr)}: ${job.event} ${job.action}`);

  const decision = decide(job, cfg);
  console.log(`decision: ${decision.review ? "review" : "skip"} (${decision.reason})`);
  if (!decision.review) return;

  const token = await installationToken(requireEnv("APP_ID"), requireEnv("APP_PRIVATE_KEY"), job.installation);
  const api = client(token);
  const base = `/repos/${job.repo}`;

  if (job.comment_id) {
    await api.post(`${base}/issues/comments/${job.comment_id}/reactions`, { content: "eyes" }).catch((e) => console.log(`reaction failed: ${e.message}`));
  }

  const pr = await api.get(`${base}/pulls/${job.pr}`);
  const marker = `<!-- review-bot head=${pr.head.sha} -->`;
  if (!decision.forced) {
    const reviews = await api.paginate(`${base}/pulls/${job.pr}/reviews`);
    if (reviews.some((r) => r.body?.includes(marker))) {
      console.log("already reviewed this head commit, skipping");
      return;
    }
  }

  const files = await api.paginate(`${base}/pulls/${job.pr}/files`);
  const diff = renderDiff(files, cfg);
  if (!diff.text) {
    console.log("no reviewable text diff, skipping");
    return;
  }

  const { value: review, model } = await complete({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    model: cfg.model,
    messages: buildMessages({ pr, diffText: diff.text, omitted: diff.omitted }),
    accept: parseReview,
  });
  console.log(`model ${model} returned ${review.comments.length} comments, verdict ${review.verdict}`);

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
    console.log(`posted review: ${inline.length} inline, ${stray.length} in body`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422) || inline.length === 0) throw e;
    console.log(`inline comments rejected (${e.message}), posting body only`);
    await api.post(`${base}/pulls/${job.pr}/reviews`, { commit_id: pr.head.sha, event, body: body([...inline, ...stray]) });
  }
}

const fmtStray = (c) => `- \`${c.path}\`${Number.isFinite(c.line) ? `:${c.line}` : ""}: ${c.body}`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
