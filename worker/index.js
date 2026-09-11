// Webhook relay. GitHub posts every event here; the Worker checks the
// signature, keeps only the events that can lead to a review, and forwards a
// small job to the review repo as a repository_dispatch. The review itself
// runs in GitHub Actions, because a free-plan Worker has 10 ms of CPU and
// 30 seconds of background time, and free models are slower than that.

const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("review-bot relay", { status: 200 });
    const body = await request.text();
    const ok = await verify(env.WEBHOOK_SECRET, request.headers.get("x-hub-signature-256"), body);
    if (!ok) return new Response("bad signature", { status: 401 });

    const job = pick(request.headers.get("x-github-event"), JSON.parse(body));
    if (!job) return new Response("ignored", { status: 200 });

    // The App can be installed on any account, so this is the gate that keeps a
    // stranger's install from spending the review repo's Actions minutes. The
    // list is passed in at deploy time; the reviewer checks it again.
    if (!allowedOwner(env.ALLOWED_REPO_OWNERS, job.repo)) return new Response("ignored", { status: 200 });
    job.ref = await ref(env.WEBHOOK_SECRET, job.repo);

    const res = await fetch(`https://api.github.com/repos/${env.DISPATCH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "review-bot-relay",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: "review-request", client_payload: job }),
    });
    if (res.status !== 204) {
      return new Response(`dispatch failed: ${res.status} ${await res.text()}`, { status: 502 });
    }
    return new Response("queued", { status: 202 });
  },
};

// pick turns a webhook into a review job, or null when the event is not one
// the reviewer acts on. Policy (who is allowed) lives in the reviewer, not here.
export function pick(event, p) {
  const base = { repo: p.repository?.full_name, installation: p.installation?.id, action: p.action };
  if (event === "pull_request" && PR_ACTIONS.has(p.action)) {
    return {
      ...base,
      event,
      pr: p.pull_request.number,
      author: p.pull_request.user.login,
      draft: p.pull_request.draft === true,
      sender: p.sender.login,
    };
  }
  if (
    event === "issue_comment" &&
    p.action === "created" &&
    p.issue.pull_request &&
    /^\/review\b/.test(p.comment.body.trim())
  ) {
    return {
      ...base,
      event,
      pr: p.issue.number,
      author: p.issue.user.login,
      sender: p.comment.user.login,
      comment_id: p.comment.id,
    };
  }
  return null;
}

// allowedOwner gates on the owner half of "owner/name". owners is a comma
// separated list, set from the REVIEWBOT_POLICY secret by the deploy workflow.
export function allowedOwner(owners, repo) {
  const owner = String(repo ?? "").split("/")[0].toLowerCase();
  return Boolean(owner) && String(owners ?? "").split(",").some((o) => o.trim().toLowerCase() === owner);
}

// ref is the anonymous handle for a repo, the only name the public Actions log
// of the review repo ever shows. Keyed by the webhook secret so a guessed repo
// name cannot be confirmed against a run title.
export async function ref(secret, repo) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(String(repo))));
  return [...mac.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verify(secret, header, body) {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const hex = header.slice("sha256=".length);
  if (hex.length !== 64 || /[^0-9a-f]/i.test(hex)) return false;
  const sig = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(body));
}
