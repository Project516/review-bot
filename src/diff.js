// Helpers over the /pulls/:n/files response: which files to skip, which
// new-side line numbers exist in a patch, and how to render the diff inside
// a character budget.

export function ignored(path, patterns = []) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return patterns.some((pat) => {
    if (pat.endsWith("/")) return path.startsWith(pat) || path.includes(`/${pat}`);
    if (pat.startsWith("*")) return path.endsWith(pat.slice(1));
    return path === pat || base === pat;
  });
}

// newSide walks a patch and yields each line with its line number in the new
// file, or null for a line that has none (hunk headers, removed lines, "no
// newline" markers).
function* newSide(patch) {
  let n = 0;
  for (const line of patch?.split("\n") ?? []) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      yield [line, null];
    } else if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      yield [line, n++];
    } else {
      yield [line, null];
    }
  }
}

// validLines lists the RIGHT-side line numbers a review comment may attach to:
// added and context lines in the patch's hunks.
export function validLines(patch) {
  const lines = new Set();
  for (const [, n] of newSide(patch)) if (n !== null) lines.add(n);
  return lines;
}

// lineTexts maps each commentable new-side line number to its text.
export function lineTexts(patch) {
  const out = new Map();
  for (const [line, n] of newSide(patch)) if (n !== null) out.set(n, line.slice(1));
  return out;
}

export const gutter = (n) => String(n ?? "").padStart(6) + "  ";

// numbered prefixes every new-side line with its line number, so the model reads
// the number off the page instead of counting from the hunk header.
function numbered(patch) {
  return [...newSide(patch)].map(([line, n]) => gutter(n) + line).join("\n");
}

const TRUNCATED = "\n... (truncated)";
const MIN_SHOWN = 1500;

const squash = (s) => s.replace(/\s+/g, " ").trim();

// anchorByQuote checks each comment's line against the text the model says it
// is about. A comment whose line holds that text stays. One that points
// elsewhere moves to the only line in the file that does, and otherwise loses its
// line, so it is listed in the review body instead of landing on the wrong code.
// A comment with no quote is left alone.
export function anchorByQuote(comments, patches) {
  return comments.map((c) => {
    const quote = squash(c.quote?.split("\n")[0] ?? "");
    if (quote.length < 4 || !patches.has(c.path)) return c;
    const texts = lineTexts(patches.get(c.path));
    if (texts.has(c.line) && squash(texts.get(c.line)).includes(quote)) return c;
    const hits = [...texts].filter(([, t]) => squash(t).includes(quote));
    return { ...c, line: hits.length === 1 ? hits[0][0] : Number.NaN };
  });
}

// settleVerdict turns the model's verdict into the one that is posted. The bot
// is the gate for auto-merge, so a review that has nothing to fix approves,
// whatever the model called it, and low-severity comments ride along on the
// approval. Only a review that could not be done properly stays a comment, and
// it says why in a note. A request for changes needs a comment that survived
// the audit.
//
//   kept       the comments left after the audit
//   unchecked  the audit could not run
//   unseen     files whose diff the model never got
//   open       earlier points of the bot that nobody has settled
export function settleVerdict({ verdict, kept, unchecked = false, unseen = [], open = 0 }) {
  if (unchecked) return { verdict: "comment", note: "Not approved: the check on these comments could not run, so they are unverified." };
  if (unseen.length) return { verdict: "comment", note: `Not approved: the diff of ${unseen.join(", ")} was too large to read.` };
  if (open) return { verdict: "comment", note: `Not approved: ${open} earlier point${open === 1 ? " is" : "s are"} still open in the threads.` };
  return { verdict: verdict === "request_changes" && kept.length ? "request_changes" : "approve", note: "" };
}

// splitComments sorts model comments into inline (a real line in the diff)
// and stray (everywhere else). A review that requests changes needs an inline
// comment: replies settle threads, and a request with no thread under it could
// never be cleared, so it becomes a comment.
export function splitComments(comments, valid, verdict) {
  const inline = [];
  const stray = [];
  for (const c of comments) {
    if (valid.get(c.path)?.has(c.line)) inline.push({ path: c.path, line: c.line, side: "RIGHT", body: c.body });
    else stray.push(c);
  }
  return { inline, stray, verdict: verdict === "request_changes" && !inline.length ? "comment" : verdict };
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|[._-](test|spec)\.[^/]*$|(^|\/)test_[^/]*$/i;

// renderDiff produces the markdown the model reads, the files it did not get to
// see and why, and the files it saw only the start of. Source files are drawn
// before test files so a tight budget is spent on the code under review, and a
// file that does not fit whole is cut rather than dropped when there is room for
// a useful part of it. The file named in first is drawn before any other.
export function renderDiff(files, { ignore_paths = [], max_diff_chars = 60000, first } = {}) {
  const perFile = Math.floor(max_diff_chars / 3);
  const omitted = [];
  const cut = [];
  let text = "";
  let budget = max_diff_chars;

  const rank = (f) => (f.filename === first ? -1 : TEST_PATH.test(f.filename) ? 1 : 0);
  for (const f of [...files].sort((a, b) => rank(a) - rank(b))) {
    if (ignored(f.filename, ignore_paths)) {
      omitted.push({ path: f.filename, reason: "ignored path" });
      continue;
    }
    if (!f.patch) {
      omitted.push({ path: f.filename, reason: `${f.status}, no text diff` });
      continue;
    }
    const header = `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n`;
    const frame = (patch) => `${header}\`\`\`diff\n${patch}\n\`\`\`\n\n`;
    const room = Math.min(perFile, budget - frame("").length - TRUNCATED.length);
    let patch = numbered(f.patch);
    if (patch.length > Math.min(perFile, budget - frame("").length)) {
      if (room < MIN_SHOWN) {
        omitted.push({ path: f.filename, reason: "diff budget exhausted" });
        continue;
      }
      patch = patch.slice(0, room) + TRUNCATED;
      cut.push(f.filename);
    }
    const block = frame(patch);
    text += block;
    budget -= block.length;
  }
  return { text, omitted, cut };
}
