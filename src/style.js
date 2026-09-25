// House style applied to the model's text before publication. The prompt asks for
// it; this guarantees it, because asking a model is not a guarantee.
//
// A dash becomes a comma between clause halves, or a space after a finished
// sentence. Those two stay grammatical wherever a dash can appear. Guessing at a
// colon or a semicolon was tried and put colons mid-sentence, so a dash that
// cannot be classified is left alone: a mangled review is worse than a dashed one.

const SPANS = [/```[\s\S]*?```/g, /`[^`\n]*`/g, /\]\([^)]*\)/g, /<!--[\s\S]*?-->/g];
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

export function stripEmDashes(text) {
  if (typeof text !== "string" || !hasDash(text)) return text;

  // Mask protected spans, rewrite, restore by index. NUL does not occur in markdown.
  const saved = [];
  const masked = text.replace(new RegExp(SPANS.map((p) => p.source).join("|"), "g"), (m) => {
    saved.push(m);
    return `\0${saved.length - 1}\0`;
  });

  const fixed = DASHES.reduce((acc, dash) => rewrite(acc, dash), masked);
  return fixed.replace(/\0(\d+)\0/g, (_, i) => saved[Number(i)] ?? "");
}

function rewrite(text, dash) {
  let out = "";
  let copied = 0;
  for (;;) {
    const at = text.indexOf(dash, copied);
    if (at === -1) return out + text.slice(copied);
    const left = rtrim(text.slice(copied, at));
    const right = ltrim(text.slice(at + dash.length));
    const replacement = punctuate(left, right);
    const gap = replacement == null ? text.slice(copied + left.length, at) : "";
    // A replacement ending in a space, followed by a newline, would leave
    // trailing whitespace. Layout wins, so the space gives way.
    const tail = text.slice(at + dash.length);
    const fixed = replacement != null && /^\s*\n/.test(tail) ? replacement.replace(/\s+$/, "") : replacement;
    out += left + gap + (fixed == null ? dash : fixed);
    // Step past the spaces the replacement supplied, or every join doubles. A
    // newline is left for the next round to copy verbatim.
    copied = at + dash.length + (fixed == null ? 0 : (tail.match(/^ */) ?? [""])[0].length);
  }
}

function punctuate(left, right) {
  if (!left.trim() || !right.trim()) return null;
  if (/\d/.test(last(left)) && /[\d.]/.test(first(right))) return null; // arithmetic or a range
  if (/^-{1,2}[A-Za-z]/.test(right)) return null; // command flag
  if (/(^|\s)[-*+•]$/.test(left)) return null; // list bullet
  if (/\|/.test(left) || /\|/.test(first(right))) return null; // table cell
  if (openDelta(left) > 0 || -openDelta(right) > 0) return " "; // brackets carry the aside
  // The left keeps its own full stop, so a space is the only addition here.
  if (/[.!?]["')\]]?$/.test(left)) return " ";
  return ", ";
}
