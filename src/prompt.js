const SYSTEM = `You are a senior engineer reviewing a pull request. Be direct and specific.

Look for: bugs, wrong logic, unhandled errors and edge cases, security problems, data loss, races, performance traps, and code that does not do what the PR says it does. Mention style only when it hides a real problem. Do not praise, do not restate the diff, do not pad.

Respond with a single JSON object and nothing else:
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
- If there is nothing worth flagging, return an empty comments array and say so in the summary.`;

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

// parseReview is lenient: models wrap JSON in fences or add prose around it.
// When nothing parses, the whole text becomes the summary.
export function parseReview(text) {
  const fallback = { summary: text.trim(), verdict: "comment", comments: [] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (typeof obj !== "object" || obj === null) return fallback;
  const comments = Array.isArray(obj.comments)
    ? obj.comments
        .filter((c) => c && typeof c.path === "string" && typeof c.body === "string")
        .map((c) => ({ path: c.path, line: Number.parseInt(c.line, 10), body: c.body.trim() }))
        .filter((c) => c.body)
    : [];
  return {
    summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : "(no summary)",
    verdict: VERDICTS.has(obj.verdict) ? obj.verdict : "comment",
    comments,
  };
}
