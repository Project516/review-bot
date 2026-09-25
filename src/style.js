// House style, applied to the model's text before anything is published.
//
// Asking a model not to use an em dash is asking nicely, and nicely is not a
// guarantee: the same model that produced a review eight-tenths wrong will
// happily reach for a dash. So the prompt asks, and this enforces it.
//
// The rule here is one sentence long because anything cleverer was tried and
// made the text worse: replace the dash with what the sentence around it needs,
// and leave it alone when that cannot be told. A comma where a full stop was
// meant reads as a mistake, and a mangled review is worse than a dashed one, so
// the bias is always toward leaving it.
//
// Protected, never touched: code spans, fenced blocks, link targets, and HTML
// comments, where a dash is either load-bearing or invisible.
//
// It runs over the summary, every comment body, and the reply text, which are
// the three places the model's own words reach a pull request.

const SPANS = [/```[\s\S]*?```/g, /`[^`\n]*`/g, /\]\([^)]*\)/g, /<!--[\s\S]*?-->/g];

// The dash characters models reach for. The minus sign is here because it is
// used interchangeably with these, but a dash next to a digit is left alone.
const DASHES = ["—", "–", "‒", "―", "−"];

const OPEN = "([{";
const CLOSE = ")]}";

const hasDash = (s) => DASHES.some((d) => s.includes(d));
const first = (s) => s[0] ?? "";
const last = (s) => s.slice(-1);
const rtrim = (s) => s.replace(/\s+$/, "");
const ltrim = (s) => s.replace(/^\s+/, "");
const tally = (s, chars) => chars.split("").reduce((n, c) => n + s.split(c).length - 1, 0);
const openDelta = (s) => tally(s, OPEN) - tally(s, CLOSE);

// stripEmDashes returns the text with each dash replaced by the punctuation the
// sentence needs, or with itself when that cannot be worked out.
export function stripEmDashes(text) {
  if (typeof text !== "string" || !hasDash(text)) return text;

  // Mask the protected spans so the rewrite cannot see inside them, then put
  // them back by index. The markers use NUL, which does not occur in markdown.
  const saved = [];
  const masked = text.replace(new RegExp(SPANS.map((p) => p.source).join("|"), "g"), (m) => {
    saved.push(m);
    return `\0${saved.length - 1}\0`;
  });

  const fixed = DASHES.reduce((acc, dash) => rewrite(acc, dash), masked);
  return fixed.replace(/\0(\d+)\0/g, (_, i) => saved[Number(i)] ?? "");
}

// rewrite walks the text once and replaces each occurrence of one dash
// character. left and right are handed to punctuate already trimmed of the space
// that sat against the dash, and every replacement brings its own space, so the
// decision only has to say which punctuation is meant.
function rewrite(text, dash) {
  let out = "";
  let copied = 0; // how much of the source has been copied into out
  for (;;) {
    const at = text.indexOf(dash, copied);
    if (at === -1) return out + text.slice(copied);
    const left = rtrim(text.slice(copied, at));
    const right = ltrim(text.slice(at + dash.length));
    const replacement = punctuate(left, right);
    // Drop the space that was against the dash when the dash is replaced, since
    // the replacement carries its own. Keep it when the dash stays.
    const gap = replacement == null ? text.slice(copied + left.length, at) : "";
    // A replacement ending in a space must not also be followed by a newline,
    // or the line ends in trailing whitespace. The newline is layout, so the
    // space gives way to it.
    const tail = text.slice(at + dash.length);
    const fixed = replacement != null && /^\s*\n/.test(tail) ? replacement.replace(/\s+$/, "") : replacement;
    out += left + gap + (fixed == null ? dash : fixed);
    // Step past the whitespace the replacement has now supplied, otherwise the
    // next round keeps the original space too and every join comes out doubled.
    // Only a run of spaces is stepped over, so a newline is copied verbatim.
    const rest = fixed == null ? "" : (tail.match(/^ */) ?? [""])[0].length;
    copied = at + dash.length + rest;
  }
}

// punctuate returns the replacement for one dash, or null to keep it. The text
// either side arrives already trimmed of the space that sat against the dash, so
// every replacement below ends with the space it needs and nothing doubles up.
//
// The mapping is deliberately two rules wide. A first attempt also tried to
// guess whether the dash was standing in for a colon, a semicolon or
// parentheses, and a comma turned up where a full stop belonged often enough to
// be worse than leaving the dash alone. A comma and a period are the two
// replacements that stay grammatical in every position a dash can occupy in
// prose, so those are the only two used.
function punctuate(left, right) {
  if (!left.trim() || !right.trim()) return null; // an edge, or a bullet marker

  // Arithmetic, a range, a negative number, a command flag: not punctuation.
  if (/\d/.test(last(left)) && /[\d.]/.test(first(right))) return null;
  if (/^-{1,2}[A-Za-z]/.test(right)) return null;

  // A list bullet or a table boundary.
  if (/(^|\s)[-*+•]$/.test(left)) return null;
  if (/\|/.test(left) || /\|/.test(first(right))) return null;

  // Inside a bracketed aside, or opening one. The brackets already carry that
  // meaning, so the dash only needs to become a pause or stay as it is.
  if (openDelta(left) > 0 || -openDelta(right) > 0) return " ";

  // The left side already ended in terminal punctuation, so it keeps that and
  // the dash becomes the space between the two sentences. Adding a second full
  // stop here is how you get "ended.." , so a plain space is the only answer.
  if (/[.!?]["')\]]?$/.test(left)) return " ";

  // Anything else sits between two clause halves, where a comma is right.
  return ", ";
}
