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

// siblingsOf lists one directory's contents at the base ref, so a model can be
// shown what else lives beside a file the PR adds, which has no earlier version
// to show. Only names are fetched, so this stays one cheap call per folder.
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

// prFacts is the shape of the PR. The title and description are already in the
// prompt, so they are not repeated here.
export function prFacts({ files, baseRef }) {
  const lines = [];
  if (baseRef) lines.push(`base branch: ${baseRef}`);
  lines.push(`files changed: ${files.length}`);
  return lines.join("\n");
}

// The code around a change is the fact the model cannot do without, so it gets
// the larger share of the budget. Folder listings fill whatever it leaves, and
// the checks and the description are set aside first because they are small and
// the model leans on them hardest.
const CODE_SHARE = 0.7;
const PER_FILE_CHARS = 3000;

// renderFacts is the block appended to the user message. It is labelled as
// gathered facts, with the gaps named, so a model that finds nothing wrong
// stops rather than inventing a problem to have something to say.
//
// context maps a changed file to the code around its changes at head (see
// headContext), or null when it could not be read, or is null as a whole when
// the repository could not be read at all.
//
// max_chars caps the whole block, because the model's context is the limit that
// actually bites. A pull request touching thirty files would otherwise send more
// code than any pinned model can hold, and the request comes back 400 on every
// one of them, so the run fails having spent its whole rotation. A truncated
// review beats no review. Anything the cap leaves out is named in the gaps line,
// the same as anything that could not be read, so a file that was cut never
// reads as a file that was clean.
export function renderFacts({ context, siblings, checks, pr, max_chars = 15000 }) {
  const held = (checks ? checks.length : 0) + (pr ? pr.length : 0) + 400;
  const codeBudget = Math.max(0, Math.floor((max_chars - held) * CODE_SHARE));
  const readable = [...(context ?? [])].filter(([, text]) => text);
  const perFile = Math.max(400, Math.min(PER_FILE_CHARS, Math.floor(codeBudget / Math.max(1, readable.length))));

  const parts = [];
  const cut = [];
  const partial = [];
  let spent = 0;
  for (const [path, text] of readable) {
    const block = `### code around the changes in ${path}, at the head commit\n\`\`\`\n${truncate(text, perFile)}\n\`\`\``;
    if (spent + block.length > codeBudget) {
      cut.push(path);
      continue;
    }
    if (text.length > perFile) partial.push(path);
    parts.push(block);
    spent += block.length;
  }
  const cutDirs = [];
  for (const [dir, names] of siblings ?? []) {
    if (dir.endsWith("/") || names == null) continue; // the added-names marker
    if (!names.length) continue;
    const block = `### what else is in ${dir || "the repository root"} on the base branch\n${names.map((n) => `- ${n}`).join("\n")}`;
    if (spent + block.length > max_chars - held) {
      cutDirs.push(dir);
      continue;
    }
    parts.push(block);
    spent += block.length;
  }
  if (checks) parts.push(`### checks at the head commit\n${checks}`);
  if (pr) parts.push(`### about this pull request\n${pr}`);
  if (!parts.length) return "";

  const unreadable = [...(context?.keys() ?? [])].filter((p) => context.get(p) === null);
  const missingDir = [...(siblings?.keys() ?? [])].filter((d) => !d.endsWith("/") && siblings.get(d) == null);
  const gaps = [
    "the rest of the repository is not shown: a function, class or setting that the diff uses but does not define is unknown to you, so do not describe it",
    "a file this pull request adds is shown whole in the diff, so for those you get the names of what is beside them instead",
    context == null ? "the files around the changes could not be read at all" : null,
    unreadable.length ? `no surrounding code available for: ${unreadable.join(", ")}` : null,
    missingDir.length ? `could not list: ${missingDir.map((d) => d || "the root").join(", ")}` : null,
    partial.length ? `only part of the surrounding code is shown for: ${partial.join(", ")}` : null,
    cut.length ? `left out of this review to keep the prompt within what the model can hold: ${cut.join(", ")}` : null,
    cutDirs.length ? `folders left out for the same reason: ${cutDirs.map((d) => d || "the root").join(", ")}` : null,
    "nothing here is the result of running the code, so behaviour claims still need to be reasoned about",
  ].filter(Boolean);
  return `## Facts gathered for this review\n\n${parts.join("\n\n")}\n\nWhat was not available: ${gaps.join("; ")}.`;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}\n... (truncated)` : s);
