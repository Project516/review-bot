// Sync mode. A PR that merges an upstream release carries thousands of lines the
// bot cannot read and the fork did not write. What can break is the fork's own
// patch on top of the new upstream code, so only that is reviewed.
import { ignored } from "./diff.js";

const PAGE = 100;
const MAX_PAGES = 3; // the compare API lists at most 300 files

export const isSyncBranch = (ref, prefixes = []) => typeof ref === "string" && prefixes.some((p) => p && ref.startsWith(p));

// syncDiff returns { files, empty, upstream, note } for a sync PR, or null when
// the PR should get its normal review. files are the compare entries of the files
// the PR changes that differ from the upstream parent. It returns null on any
// doubt, because the normal path never approves what it cannot read.
export async function syncDiff({ api, base, pr, prFiles, cfg, log = () => {} }) {
  if (!isSyncBranch(pr.head?.ref, cfg.sync_branch_prefixes)) return null;
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) return null;
  try {
    const commit = await api.get(`${base}/commits/${pr.head.sha}`);
    if (commit.parents?.length !== 2) {
      log("sync branch, but the head is not a merge commit, reviewing normally");
      return null;
    }
    const upstream = commit.parents[1].sha;
    const changed = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await api.get(`${base}/compare/${upstream}...${pr.head.sha}?per_page=${PAGE}&page=${page}`);
      changed.push(...res.files);
      if (res.files.length < PAGE) break;
    }
    if (changed.length >= PAGE * MAX_PAGES) {
      log("sync compare may be cut off, reviewing normally");
      return null;
    }
    const inPr = new Set(prFiles.map((f) => f.filename));
    const files = changed.filter((f) => inPr.has(f.filename));
    const short = upstream.slice(0, 7);
    const empty = files.every((f) => ignored(f.filename, cfg.ignore_paths));
    return {
      files,
      empty,
      upstream,
      note: empty
        ? `Clean upstream merge. No file this PR changes differs from upstream commit ${short}, so there is nothing fork-specific to review.`
        : `This review covered only the fork's own changes on top of upstream commit ${short} (branch ${pr.head.ref}). Upstream code was not reviewed.`,
    };
  } catch (e) {
    log(`sync diff unavailable, reviewing normally: ${e.message}`);
    return null;
  }
}

// syncPrompt tells the model what the diff is, so it leaves upstream code alone.
export const syncPrompt = (sync) =>
  `This pull request merges an upstream release into a fork. The diff below is only the fork's own changes on top of upstream commit ${sync.upstream.slice(0, 7)}, in the files this merge changes. The upstream code itself is not shown and is not under review: do not comment on it. Review whether the fork's changes still make sense against the code around them.`;
