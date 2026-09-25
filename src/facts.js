// Facts a review can check instead of guessing.
//
// The bot reviews a diff and nothing else. It has no repo, no shell, and no
// memory of last time, so any claim that needs something it was not shown comes
// out as a guess. In one run of ten comments, eight rested on one of these:
//
//   - the rest of the repo (does something else already do this?)
//   - the live world (is this version out, does this API answer like that?)
//   - a fact about the code it cannot see (what is in this package?)
//
// So review.js gathers what it can reach and hands it to the model, and the
// prompt says plainly what it is looking at. Anything not gathered here is
// something the model has to skip or mark as unverified. Nothing in here is
// specific to any one repository: the same code has to hold up reviewing a
// Rust service, a Flutter app, and a Java library.
import { ignored } from "./diff.js";

// baselineOf reads the file at the base ref, so the model can see the code the
// patch is changing rather than only the patch. A file the patch does not touch
// is invisible to a diff-only review, and that is how a model reports a
// version or a pattern as wrong when something else in the repo already sets it
// that way. Paths that are ignored, removed, or unreadable come back as null,
// never as a guess, and a failure on one path does not fail the review.
//
// A file the PR adds has no base version, which is exactly the case where the
// model most needs the surroundings: a new workflow alongside existing ones, a
// new module next to the ones it sits beside. So siblings takes a list of paths
// to look up instead, which is how a new file gets its neighbours. It returns
// what it found and the paths it could not read, and the caller says so in the
// prompt rather than letting a silence read as an all-clear.
export async function baselineOf(api, repo, ref, files, { ignore_paths = [] } = {}) {
  const out = new Map();
  for (const f of files) {
    const path = f.filename;
    if (ignored(path, ignore_paths) || f.status === "removed") {
      out.set(path, null);
      continue;
    }
    out.set(path, await readAtRef(api, repo, ref, path));
  }
  return out;
}

// siblingsOf lists one directory's contents at the base ref, so a model can be
// shown what else lives beside a file the PR adds. Only the directory the paths
// share are fetched, and only names, so this stays one cheap call per folder.
export async function siblingsOf(api, repo, ref, files, { ignore_paths = [], max_names = 60 } = {}) {
  const dirs = new Map();
  for (const f of files) {
    const path = f.filename;
    if (ignored(path, ignore_paths)) continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    dirs.get(dir).add(path.split("/").pop());
  }
  const out = new Map();
  for (const [dir, names] of dirs) {
    const list = await readDirAtRef(api, repo, ref, dir);
    out.set(dir, list ? [...list].sort().slice(0, max_names) : null);
    out.set(`${dir}/`, names); // the names the patch itself adds, for the note
  }
  return out;
}

async function readAtRef(api, repo, ref, path) {
  // The ref may be a branch name GitHub does not take in a contents path, so a
  // failure here is expected and must not fail the review.
  const url = `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await api.get(url);
    return res?.content ? Buffer.from(res.content, "base64").toString("utf8") : null;
  } catch {
    return null;
  }
}

async function readDirAtRef(api, repo, ref, dir) {
  const path = dir ? `${dir}/` : "";
  const url = `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await api.get(url);
    return Array.isArray(res) ? res.map((e) => e.name) : null;
  } catch {
    return null;
  }
}

// encodePath keeps the slashes: GitHub wants a/b/c.js, and percent-encoding them
// turns one path into a name that does not exist.
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

// checksBrief is the CI state at the head commit. It tells the model whether
// the tests already ran and what they said, so a claim about a broken build can
// be checked against the run rather than predicted.
export function checksBrief(runs, { more = 0 } = {}) {
  if (!runs?.length) return null;
  const lines = runs.map((r) => `- ${r.name}: ${r.conclusion ?? r.status}`);
  if (more) lines.push(`- and ${more} more`);
  return lines.join("\n");
}

// prFacts is what the PR says about itself. A review that never reads the
// description cannot notice that the description and the code disagree, which
// is how a comment ends up saying the code contradicts its own docs.
export function prFacts({ pr, files, baseRef }) {
  const lines = [];
  if (baseRef) lines.push(`base branch: ${baseRef}`);
  lines.push(`files changed: ${files.length}`);
  if (pr?.title) lines.push(`title: ${pr.title}`);
  if (pr?.body?.trim()) lines.push(`description:\n${pr.body.trim()}`);
  return lines.join("\n");
}

// renderFacts is the block appended to the user message. It is labelled as
// gathered facts, with the gaps named, so a model that finds nothing wrong
// stops rather than inventing a problem to have something to say.
export function renderFacts({ baseline, siblings, checks, pr, ignore_paths = [] }) {
  const parts = [];
  for (const [path, text] of baseline ?? []) {
    if (text == null) continue;
    parts.push(`### ${path} as it is on the base branch\n\`\`\`\n${truncate(text, 4000)}\n\`\`\``);
  }
  for (const [dir, names] of siblings ?? []) {
    if (dir.endsWith("/") || names == null) continue; // the added-names marker
    if (!names.length) continue;
    parts.push(`### what else is in ${dir || "the repository root"} on the base branch\n${names.map((n) => `- ${n}`).join("\n")}`);
  }
  if (checks) parts.push(`### checks at the head commit\n${checks}`);
  if (pr) parts.push(`### about this pull request\n${pr}`);
  if (!parts.length) return "";

  const missingBase = [...(baseline?.keys() ?? [])].filter((p) => baseline.get(p) == null);
  const missingDir = [...(siblings?.keys() ?? [])].filter((d) => !d.endsWith("/") && siblings.get(d) == null);
  const gaps = [
    "the base version of a file this pull request adds does not exist yet, so for those you get the names of what is beside them instead",
    missingBase.length ? `no base version available for: ${missingBase.join(", ")}` : null,
    missingDir.length ? `could not list: ${missingDir.map((d) => d || "the root").join(", ")}` : null,
    "nothing here is the result of running the code, so behaviour claims still need to be reasoned about",
  ].filter(Boolean);
  return `## Facts gathered for this review\n\n${parts.join("\n\n")}\n\nWhat was not available: ${gaps.join("; ")}.`;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}\n... (truncated)` : s);
