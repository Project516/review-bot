const SYSTEM = `You are a senior engineer reviewing a pull request. Be direct and specific.

Look for: bugs, wrong logic, unhandled errors and edge cases, security problems, data loss, races, performance traps, and code that does not do what the PR says it does. Mention style only when it hides a real problem. Do not praise, do not restate the diff, do not pad.

Respond with a single JSON object and nothing else. No working notes, no reasoning, no text before or after it. Decide first, then write only the object:
{
  "summary": "markdown, a few sentences on what the change does and the main risks",
  "verdict": "approve" | "comment" | "request_changes",
  "comments": [
    { "path": "file path exactly as shown in the diff header", "line": 42, "body": "markdown, one issue, say what is wrong and what to do" }
  ]
}

Rules for comments:
- "line" is a line number in the NEW version of the file. It must be a line that appears in the diff as added (+) or context ( ). Never comment on removed (-) lines; mention those in the summary instead.
- Work out the number from the @@ -old,+new @@ hunk headers. Count carefully.
- At most 10 comments. Skip anything you are not sure about.
- If there is nothing worth flagging, return an empty comments array and say so in the summary.

The reply must start with { and end with }. A reply that is not that object is discarded.`;

export function buildMessages({ pr, diffText, omitted }) {
  const omittedNote = omitted.length
    ? `\n\nFiles changed but not shown:\n${omitted.map((o) => `- ${o.path} (${o.reason})`).join("\n")}`
    : "";
  const user = `Repository: ${pr.base.repo.full_name}
PR #${pr.number}: ${pr.title}
Branch: ${pr.head.ref} into ${pr.base.ref}
Files changed: ${pr.changed_files}, +${pr.additions} -${pr.deletions}

PR description:
${pr.body?.trim() || "(none)"}

Diff:

${diffText}${omittedNote}`;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

const VERDICTS = new Set(["approve", "comment", "request_changes"]);

// Models that think out loud wrap the notes in tags. Drop those first so a
// brace inside them cannot be mistaken for the review.
const THINK = /<(think|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi;
const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

// parseReview is lenient about what surrounds the JSON and strict about the
// JSON itself. It returns null when the reply is not a review: a bare safety
// classifier verdict, prose, or a chain of thought that ran out of tokens
// before the JSON. The caller retries instead of publishing that text.
export function parseReview(text) {
  const cleaned = text.replace(THINK, "");
  const brace = cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1);
  for (const candidate of [cleaned.match(FENCE)?.[1], cleaned, brace]) {
    const review = coerce(candidate);
    if (review) return review;
  }
  return null;
}

function coerce(candidate) {
  if (!candidate?.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
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
