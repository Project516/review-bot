// decide answers one question: does this job get a review, and why.
// job comes from the Worker (see worker/index.js pick), cfg from reviewbot.json.
export function decide(job, cfg) {
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const listed = (list, name) => list.some((x) => same(x, name));
  const skip = (reason) => ({ review: false, forced: false, reason });

  const repoOwner = job.repo?.split("/")[0];
  if (!listed(cfg.allowed_repo_owners, repoOwner)) return skip(`repo owner ${repoOwner} is not allowed`);

  if (job.event === "issue_comment") {
    if (!same(job.sender, cfg.owner)) return skip(`/review from ${job.sender}, only ${cfg.owner} may request one`);
    return { review: true, forced: true, reason: `/review by ${job.sender}` };
  }

  if (job.event === "pull_request") {
    if (job.draft) return skip("draft PR, reviewed when marked ready");
    if (!listed(cfg.allowed_authors, job.author)) {
      return skip(`author ${job.author} is not on the list; ${cfg.owner} can comment /review to opt in`);
    }
    return { review: true, forced: false, reason: `${job.action} by allowed author ${job.author}` };
  }

  return skip(`unhandled event ${job.event}`);
}
