// Weekly refresh of the model pins. Fetches the OpenRouter catalog, ranks the
// free models, and opens a PR that rewrites the models list in reviewbot.json.
// It never pushes to master and never merges: the human who reads the ranking
// decides. Run it by hand with workflow_dispatch, or let the schedule do it.
//
// This job names no repo, owner or author, and the only thing it reads out of
// the catalog is model ids, which are public.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { fetchCatalog, rank, planPins, compare, renderReport, renderPins, settings, carryOverNotes, withNotes } from "./models.js";

const CONFIG_PATH = new URL("../reviewbot.json", import.meta.url);
const BRANCH = "models/weekly-pins";

const log = (m) => console.log(`[models] ${m}`);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// The pins are written back into reviewbot.json in place, so a week with no
// change produces no diff at all. renderPins does the parse, so this only
// decides whether there is anything to write.
function writePins(desired, ranked) {
  // The pins are the list of names, and the runners-up are written beside them
  // by the weekly refresh so a review run can use them without fetching the
  // catalog. Both come from the same file, so they cannot drift apart.
  const text = readFileSync(CONFIG_PATH, "utf8");
  const body = renderPins(text, desired);
  const extras = ranked.slice(desired.length).map((r) => r.id);
  const updated = extras.length ? withRunnersUp(body, extras) : dropRunnersUp(body);
  if (updated === text) {
    log("pins already current, no edit needed");
    return false;
  }
  writeFileSync(CONFIG_PATH, updated);
  log(`pins written: ${desired.join(", ")}`);
  if (extras.length) log(`runners-up recorded: ${extras.length}`);
  return true;
}

// RUNNERS_KEY is where the weekly refresh records the models that did not make
// the cut. Without it a review run knows only the pins, so a pin that leaves the
// free list has nothing to fall back on but the router.
export const RUNNERS_KEY = "model_runners_up";

// withRunnersUp records the runners-up without disturbing anything else in the
// config, and drops the key when the list is empty so a stale list cannot
// outlive the ranking that produced it.
export function withRunnersUp(text, extras) {
  const config = JSON.parse(text);
  if (!extras.length) delete config[RUNNERS_KEY];
  else config[RUNNERS_KEY] = extras;
  return `${JSON.stringify(config, null, 2)}\n`;
}

// dropRunnersUp clears a list left by an earlier run when this week has no
// runners-up to record, rather than keeping names that are no longer ranked.
export function dropRunnersUp(text) {
  if (!(RUNNERS_KEY in JSON.parse(text))) return text;
  return withRunnersUp(text, []);
}

// resetToMaster puts the tree on a fresh branch off master. Always from master,
// so a week that reorders the pins never carries last week's commit on top of
// it. It runs before the config is read, so the ranking and the commit are
// planned from the same tree.
function resetToMaster() {
  git("config", "user.name", "review-bot");
  git("config", "user.email", "review-bot@users.noreply.github.com");
  git("checkout", "-B", BRANCH, "origin/master");
}

// The commit names no account and no repo, and the author is the bot's own
// identity so the history does not carry anyone's name.
function commitAndPush({ current, desired, change }) {
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
  // The working tree is the branch everything below reads and writes, so it is
  // reset to master before the config is loaded rather than inside the commit
  // step. Otherwise a leftover edit from a previous run would be ranked and
  // then thrown away, and the pins would be planned from a tree the commit does
  // not match.
  resetToMaster();
  const cfg = loadConfig();
  const current = Array.isArray(cfg.models) ? cfg.models : [];
  const { pin } = settings(cfg);
  const currentRunners = Array.isArray(cfg[RUNNERS_KEY]) ? cfg[RUNNERS_KEY] : [];

  const catalog = await fetchCatalog({ log });
  const { ranked, rejected, free } = rank(catalog, cfg);
  const change = compare(current, ranked, rejected, cfg);
  const desired = planPins(ranked, cfg);
  const desiredRunners = ranked.slice(pin).map((r) => r.id);
  // The runners-up are half of what this job writes, and a review run reads
  // them, so a week that only reshuffles them is still a change. Checking the
  // pins alone left the job silent on a week that reorders the fallback list,
  // which is exactly the week the runners-up exist to record.
  const runnersChanged = desiredRunners.join() !== currentRunners.join();

  log(`free models: ${free}, rankable: ${ranked.length}, pinning ${pin}`);
  for (const r of ranked) log(`  ${String(r.coding).padStart(5)}  ${r.id}  ctx ${r.context}`);
  for (const g of change.gone) log(`  GONE: ${g.id} (${g.reason})`);
  for (const o of change.outranked) log(`  out of the pins this week: ${o.id} (${o.reason})`);

  const body = renderReport({ ranked, rejected, current, change, cfg, free });
  if (!change.changed && !runnersChanged) {
    log("this week's ranking matches the pins and the runners-up, nothing to open");
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

  writePins(desired, ranked);
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

// main runs on import only when this file is the entry point, so a test can
// import the helpers above without the job starting, fetching a catalog and
// writing the config as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`[models] ${e?.stack ?? e}`);
    process.exit(1);
  });
}
