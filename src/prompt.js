const SYSTEM = `You are a senior engineer reviewing a pull request. Be direct and specific.

Look for: bugs, wrong logic, unhandled errors and edge cases, security problems, data loss, races, performance traps, and code that does not do what the PR says it does. Mention style only when it hides a real problem. Do not praise, do not restate the diff, do not pad.

Comments are only for problems the author should act on. Never describe what the change does and never praise it; that belongs in the summary, if anywhere.

Respond with a single JSON object and nothing else. No working notes, no reasoning, no text before or after it. Decide first, then write only the object:
{
  "summary": "markdown, a few sentences on what the change does and the main risks",
  "verdict": "approve" | "comment" | "request_changes",
  "comments": [
    { "path": "file path exactly as shown in the diff header", "line": 42, "body": "markdown, one issue, say what is wrong and what to do" }
  ]
}

Verdict:
- "approve" when nothing needs to change. comments must be empty and the summary is one or two sentences.
- "request_changes" only when at least one comment is something that must be fixed before merge.
- "comment" for non-blocking notes.

Rules for comments:
- "line" is a line number in the NEW version of the file. It must be a line that appears in the diff as added (+) or context ( ). Never comment on removed (-) lines; mention those in the summary instead.
- Work out the number from the @@ -old,+new @@ hunk headers. Count carefully.
- At most 10 comments. Skip anything you are not sure about.
- If there is nothing worth flagging, return an empty comments array and say so in the summary.

The reply must start with { and end with }. A reply that is not that object is discarded.`;

export function buildMessages({ pr, diffText, omitted, settled = [] }) {
  const omittedNote = omitted.length
    ? `\n\nFiles changed but not shown:\n${omitted.map((o) => `- ${o.path} (${o.reason})`).join("\n")}`
    : "";
  const settledNote = settled.length
    ? `\n\nPoints already settled in discussion with the author, do not raise them again unless the new code reintroduces the problem:\n${settled.map((s) => `- \`${s.path}\`: ${truncate(s.body, 300)}`).join("\n")}`
    : "";
  const user = `Repository: ${pr.base.repo.full_name}
PR #${pr.number}: ${pr.title}
Branch: ${pr.head.ref} into ${pr.base.ref}
Files changed: ${pr.changed_files}, +${pr.additions} -${pr.deletions}

PR description:
${pr.body?.trim() || "(none)"}

Diff:

${diffText}${omittedNote}${settledNote}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

function truncate(text, max) {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

const VERDICTS = new Set(["approve", "comment", "request_changes"]);

// Models that think out loud wrap the notes in tags. Drop those first so a
// brace inside them cannot be mistaken for the review.
const THINK = /<(think|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi;
const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

// firstValid is lenient about what surrounds the JSON and strict about the
// JSON itself: it tries the fenced block, the whole reply, then the outermost
// braces, and returns whatever coerce() accepts first. Used by both parsers so
// a bare safety classifier verdict, prose, or a chain of thought that ran out
// of tokens before the JSON is rejected the same way in each.
function firstValid(text, coerce) {
  const cleaned = text.replace(THINK, "");
  const brace = cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1);
  for (const candidate of [cleaned.match(FENCE)?.[1], cleaned, brace]) {
    const value = coerce(candidate);
    if (value) return value;
  }
  return null;
}

function parseJson(candidate) {
  if (!candidate?.trim()) return undefined;
  try {
    const obj = JSON.parse(candidate);
    return typeof obj === "object" && obj !== null ? obj : undefined;
  } catch {
    return undefined;
  }
}

// parseReview returns null when the reply is not a review. The caller retries
// instead of publishing that text.
export function parseReview(text) {
  return firstValid(text, coerceReview);
}

function coerceReview(candidate) {
  const obj = parseJson(candidate);
  if (!obj) return null;
  if (typeof obj.summary !== "string" || !obj.summary.trim()) return null;
  const comments = Array.isArray(obj.comments)
    ? obj.comments
        .filter((c) => c && typeof c.path === "string" && typeof c.body === "string")
        .map((c) => ({ path: c.path, line: Number.parseInt(c.line, 10), body: c.body.trim() }))
        .filter((c) => c.body)
    : [];
  return {
    summary: obj.summary.trim(),
    verdict: VERDICTS.has(obj.verdict) ? obj.verdict : "comment",
    comments,
  };
}

// parseReply returns null when the reply is not a usable thread reply.
export function parseReply(text) {
  return firstValid(text, coerceReply);
}

function coerceReply(candidate) {
  const obj = parseJson(candidate);
  if (!obj) return null;
  if (typeof obj.reply !== "string" || !obj.reply.trim()) return null;
  const resolved = coerceBool(obj.resolved);
  if (resolved === null) return null;
  return { reply: obj.reply.trim(), resolved };
}

function coerceBool(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

const REPLY_SYSTEM = `You are the reviewer who left the first comment in this review thread on a pull request. Someone has replied. Read the thread and the current diff of that file at the head of the PR, then decide whether your original concern still stands.

Set "resolved" true when the latest head fixes the concern, or the author's reasoning is correct and there is nothing left to change. Set it false when the concern still stands.

The reply is short and specific: no filler, no praise. When resolved is false, say exactly what still needs to change or why the pushback does not hold.

Respond with a single JSON object and nothing else. No working notes, no reasoning, no text before or after it:
{
  "reply": "markdown, a short specific reply",
  "resolved": true | false
}

The reply must start with { and end with }. A reply that is not that object is discarded.`;

// buildReplyMessages describes one review thread: the root comment's location
// in the diff, the current patch for that file, and every comment so far with
// the bot's own marked as "you" using slug, the App's bot login.
export function buildReplyMessages({ pr, thread, patch, slug }) {
  const nodes = thread.comments.nodes;
  const root = nodes[0];
  // Thread data comes from GraphQL, which reports a bot author's login as the
  // bare App slug (REST appends "[bot]").
  const isYou = (login) => typeof login === "string" && typeof slug === "string" && login.toLowerCase() === slug.toLowerCase();
  const lines = nodes.map((c) => `${isYou(c.author?.login) ? "you" : c.author?.login ?? "someone"}: ${c.body}`);
  const user = `Repository: ${pr.repo}
PR #${pr.number}

Root comment:
- path: ${root.path}
- line: ${root.line ?? root.originalLine ?? "unknown"}
- diff_hunk:
${root.diffHunk ?? "(none)"}

Current diff of that file:
${patch ? `\`\`\`diff\n${patch}\n\`\`\`` : "(file not in the current diff)"}

Thread:
${lines.join("\n")}`;
  return [
    { role: "system", content: REPLY_SYSTEM },
    { role: "user", content: user },
  ];
}
