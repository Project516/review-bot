// Weekly refresh of the model pins. Fetches the OpenRouter catalog, ranks the
// free models, and opens a PR that rewrites the models list in reviewbot.json.
// It never pushes to master and never merges: the human who reads the ranking
// decides. Run it by hand with workflow_dispatch, or let the schedule do it.
//
// This job names no repo, owner or author, and the only thing it reads out of
// the catalog is model ids, which are public.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { fetchCatalog, rank, planPins, compare, renderReport, renderPins, settings, carryOverNotes, withNotes } from "./models.js";

const CONFIG_PATH = new URL("../reviewbot.json", import.meta.url);
const BRANCH = "models/weekly-pins";

const log = (m) => console.log(`[models] ${m}`);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// The pins are written back into reviewbot.json in place, so a week with no
// change produces no diff at all. renderPins does the parse, so this only
// decides whether there is anything to write.
function writePins(models) {
  const text = readFileSync(CONFIG_PATH, "utf8");
  const updated = renderPins(text, models);
  if (updated === text) {
    log("pins already current, no edit needed");
    return false;
  }
  writeFileSync(CONFIG_PATH, updated);
  log(`pins written: ${models.join(", ")}`);
  return true;
}

// The commit names no account and no repo, and the author is the bot's own
// identity so the history does not carry anyone's name.
function commitAndPush({ current, desired, change }) {
  git("config", "user.name", "review-bot");
  git("config", "user.email", "review-bot@users.noreply.github.com");
  // Always start from master, so a week that reorders the pins never carries
  // last week's commit on top of it.
  git("checkout", "-B", BRANCH, "origin/master");
  git("add", "reviewbot.json");

  const gone = change.gone.map((g) => ` \`${g.id}\``).join("");
  git(
    "commit",
    "-m",
    "Re-pick the free models from the OpenRouter catalog",
    "-m",
    `Ranked the free models by the coding score OpenRouter publishes and kept the top ${desired.length}.${gone ? ` Left the free list:${gone}` : ""}\n\nOpened by the weekly refresh and left for review.`,
  );
  git("push", "--force", "origin", `${BRANCH}:${BRANCH}`);
  log(`pushed ${BRANCH}: ${current.join(", ") || "none"} -> ${desired.join(", ")}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
  const cfg = loadConfig();
  const current = Array.isArray(cfg.models) ? cfg.models : [];
  const { pin } = settings(cfg);

  const catalog = await fetchCatalog({ log });
  const { ranked, rejected, free } = rank(catalog, cfg);
  const change = compare(current, ranked, rejected, cfg);
  const desired = planPins(ranked, cfg);

  log(`free models: ${free}, rankable: ${ranked.length}, pinning ${pin}`);
  for (const r of ranked) log(`  ${String(r.coding).padStart(5)}  ${r.id}  ctx ${r.context}`);
  for (const g of change.gone) log(`  GONE: ${g.id} (${g.reason})`);

  const body = renderReport({ ranked, rejected, current, change, cfg, free });
  if (!change.changed) {
    log("this week's ranking matches the pins, nothing to open");
    if (!dryRun) saveReport(body);
    return;
  }
  if (!desired.length) {
    log("nothing on the free list qualifies this week, leaving the pins alone");
    saveReport(body);
    return;
  }

  if (dryRun) {
    console.log(`\n--- would pin ---\n${desired.join("\n")}\n`);
    console.log(body);
    return;
  }

  writePins(desired);
  saveReport(body);
  commitAndPush({ current, desired, change });
  const url = await openPullRequest({ body, change });
  if (url) log(`PR: ${url}`);
}

// saveReport writes the ranking to the workflow summary either way, so a week
// with no PR is still readable without digging through logs.
function saveReport(body) {
  const step = process.env.GITHUB_STEP_SUMMARY;
  if (!step) return;
  try {
    writeFileSync(step, body, { flag: "a" });
    log("ranking written to the step summary");
  } catch (e) {
    log(`step summary unavailable: ${e.message}`);
  }
}

// openPullRequest opens the weekly PR, or updates the one already open from a
// previous week rather than stacking a second, so there is only ever one to look
// at.
//
// The update is a PATCH of the whole body, which would wipe anything a human
// wrote on last week's PR, so their part is carried over by carryOverNotes.
async function openPullRequest({ body, change }) {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is needed to open the refresh PR");

  const title = change.gone.length
    ? `Weekly model pins: ${change.gone.length} pin(s) left the free list`
    : "Weekly model pins";

  // An open refresh from last week is still open: update it rather than stack a
  // second one, so there is only ever one PR to look at.
  const existing = await api("GET", `/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${BRANCH}`);
  if (existing.length) {
    const previous = (await api("GET", `/repos/${owner}/${repo}/pulls/${existing[0].number}`))?.body ?? "";
    const carried = carryOverNotes(previous);
    await api("PATCH", `/repos/${owner}/${repo}/pulls/${existing[0].number}`, { title, body: withNotes(body, carried) });
    log(`updated open PR #${existing[0].number}: ${title}${carried ? " (kept your notes)" : ""}`);
    return existing[0].html_url;
  }
  const pr = await api("POST", `/repos/${owner}/${repo}/pulls`, { title, body, head: BRANCH, base: "master" });
  log(`opened PR #${pr.number}: ${title}`);
  return pr.html_url;
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "review-bot-model-refresh",
      "x-github-api-version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
    // A stalled request would otherwise hang the job until the workflow
    // timeout, so every call here gives up in under a minute.
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

main().catch((e) => {
  console.error(`[models] ${e?.stack ?? e}`);
  process.exit(1);
});
