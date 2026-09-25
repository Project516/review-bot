// Decides which free OpenRouter models the reviewer should be pointed at this
// week, and says why.
//
// The free list turns over. A model pinned today can be gone tomorrow, and the
// free router picks for itself, sometimes handing a review to a model small
// enough to concede a point it should not hold. So the pins stay in
// reviewbot.json, this module ranks what is on the free list right now, and the
// weekly job re-runs the ranking and opens a PR. Nothing here edits the pins on
// its own: a human looks at the ranking and merges.
const CATALOG_URL = "https://openrouter.ai/api/v1/models";

// A pin has to be free, read and write text, need a published coding score so
// the choice is not a guess, and have room for a whole PR diff. A model with
// no score is left out on purpose: the unbenchmarked tail of the free list is
// where the content-safety classifiers and the 2B models live.
export const DEFAULTS = {
  pin: 5,
  min_context: 65536,
  min_completion_tokens: 16384,
};

// The router, held back for when every pin is dead. It is free, and it is the
// one entry that has to be last: it is the fallback, not the plan.
export const ROUTER = "openrouter/free";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === "string" ? v : "");

export const settings = (cfg = {}) => ({ ...DEFAULTS, ...(cfg.model_selection ?? {}) });

// fetchCatalog is the one network read, and only the weekly job does it.
export async function fetchCatalog({ url = CATALOG_URL, log = console.log, timeout = 30000 } = {}) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    // A stalled catalog read would otherwise hang the job until the workflow
    // timeout.
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`OpenRouter catalog ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const models = parseCatalog(await res.text());
  log(`catalog: ${models.length} models`);
  return models;
}

export function parseCatalog(body) {
  const data = typeof body === "string" ? JSON.parse(body) : body;
  if (!Array.isArray(data?.data)) throw new Error("OpenRouter catalog is not a list of models");
  return data.data;
}

const isFree = (m) => text(m.id).endsWith(":free") && Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0;
const speaksText = (m) => (m?.architecture?.input_modalities ?? []).includes("text") && (m?.architecture?.output_modalities ?? []).includes("text");
const coding = (m) => num(m?.benchmarks?.artificial_analysis?.coding_index);
const agentic = (m) => num(m?.benchmarks?.artificial_analysis?.agentic_index);
const intelligence = (m) => num(m?.benchmarks?.artificial_analysis?.intelligence_index);
// outputCap is the room the provider allows in one completion. A model that does
// not publish the field is treated as zero, not as unlimited: absent data is not
// evidence of a large cap, and a missing field that read as Infinity would wave
// through a model with no room to answer.
const outputCap = (m) => num(m?.top_provider?.max_completion_tokens) ?? 0;

function expired(m, now) {
  if (m?.expiration_date == null) return false;
  const t = typeof m.expiration_date === "number" ? m.expiration_date * 1000 : Date.parse(m.expiration_date);
  return Number.isFinite(t) && t <= now;
}

// rank splits the catalog into the models worth pinning, best first, and
// everything else with the one reason it was left out.
export function rank(models, cfg = {}, now = Date.now()) {
  const { min_context, min_completion_tokens } = settings(cfg);
  const ranked = [];
  const rejected = [];
  let free = 0;

  for (const m of models) {
    if (!isFree(m)) {
      // Only a model whose id still carries the :free suffix but no longer prices
      // at zero is worth naming. A paid model is not a pin that went paid: its id
      // never ended in :free, so no pin can ever have referred to it, and filing
      // all several hundred of them under "no longer free" buried the real answer.
      const id = text(m.id);
      if (!id.endsWith(":free")) continue;
      rejected.push({ id, reason: "no longer free" });
      continue;
    }
    free++;
    const id = text(m.id);
    const score = coding(m);
    const reason =
      expired(m, now) ? "expired" :
      !speaksText(m) ? "not a text model" :
      score == null ? "no published coding score" :
      (num(m.context_length) ?? 0) < min_context ? `context under ${min_context}` :
      outputCap(m) < min_completion_tokens ? `output cap under ${min_completion_tokens}` :
      null;
    if (reason) {
      rejected.push({ id, reason });
      continue;
    }
    ranked.push({
      id,
      coding: score,
      agentic: agentic(m),
      intelligence: intelligence(m),
      context: num(m.context_length),
      output_cap: outputCap(m),
    });
  }

  // Coding score decides, then the agentic and intelligence scores, then the
  // room to work, then the id so the order never wobbles between runs.
  ranked.sort(
    (a, b) => b.coding - a.coding || (b.agentic ?? -1) - (a.agentic ?? -1) || (b.intelligence ?? -1) - (a.intelligence ?? -1) || b.context - a.context || a.id.localeCompare(b.id),
  );
  return { ranked, rejected: rejected.sort((a, b) => a.id.localeCompare(b.id)), free };
}

export const planPins = (ranked, cfg = {}) => ranked.slice(0, settings(cfg).pin).map((r) => r.id);

// renderPins returns the config text with the models replaced, or the text
// unchanged when the pins are already current. Parsing and re-stringifying
// rather than matching a pattern, so a key that looks like models but is not
// one cannot be rewritten by accident, and the rest of the file keeps its own
// shape. The caller does the writing, so this stays a pure function.
export function renderPins(text, models) {
  const config = JSON.parse(text);
  // An array or a null here would stringify to something with no models key at
  // all, quietly dropping the pins. That is a broken config, so it fails loud.
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("reviewbot.json is not a JSON object");
  if (JSON.stringify(config.models) === JSON.stringify(models)) return text;
  config.models = models;
  // Two-space indent and a trailing newline match the file as checked in, so a
  // week that only reorders the pins shows a diff of the models array alone.
  return `${JSON.stringify(config, null, 2)}\n`;
}

// rotate is the order a run tries: the pins, then the runners-up the weekly
// refresh recorded, then the free router. A pin that has left the catalog costs
// one wasted attempt, the client drops it, and the next name takes over. The
// runners-up come from the config rather than a fresh fetch, so a review never
// makes a second OpenRouter call to discover its own fallback. Both plain names
// and ranked rows are accepted.
export function rotate(current = [], ranked = [], cfg = {}) {
  const seen = new Set();
  const out = [];
  // The whole ranked list, not just the pins: the pins are the first few entries
  // of it, so spreading planPins as well would only duplicate them for the seen
  // set to drop.
  for (const id of [...current, ...ranked.map((r) => (typeof r === "string" ? r : r.id))]) {
    const id_ = text(id);
    if (!id_ || id_ === ROUTER || seen.has(id_)) continue;
    seen.add(id_);
    out.push(id_);
  }
  out.push(ROUTER);
  return out;
}

// compare reads the change off the current pins: which stay, which arrive,
// which fall off the end, and which are no longer free at all. A pin that has
// left the free list is the failure this module exists to catch, so it is
// reported separately from a pin that merely ranked lower this week.
export function compare(current = [], ranked = [], rejected = [], cfg = {}) {
  const desired = planPins(ranked, cfg);
  const known = new Set(ranked.map((r) => r.id));
  const gone = [];
  const missing = [];
  for (const id of current) {
    if (known.has(id)) continue;
    // A pin is gone either because it is still in the catalog but no longer
    // free, or because it is not in the catalog at all. Only the first is
    // worth naming a reason for; the second is the common case when a model is
    // retired outright. Either way it steps out of the pins.
    const why = rejected.find((r) => r.id === id);
    if (why) gone.push({ id, reason: why.reason });
    else missing.push({ id, reason: "no longer in the catalog" });
  }
  const goneIds = new Set([...gone, ...missing].map((g) => g.id));
  return {
    desired,
    changed: desired.length !== current.length || desired.some((id, i) => id !== current[i]),
    kept: desired.filter((id) => current.includes(id)),
    added: desired.filter((id) => !current.includes(id)),
    dropped: current.filter((id) => !desired.includes(id) && !goneIds.has(id)),
    gone: [...gone, ...missing],
  };
}

// NOTES_HEADING is where carried-over human notes go. The bot never writes a
// line under it, so the two never argue.
export const NOTES_HEADING = "## Your notes on last week";

const BOT_SECTIONS = ["## What this is", "## Before you merge", "## This week", "## Pinned", "## Next in line", "## No longer free", "## Left out", "## Was pinned"];

// carryOverNotes returns what a human wrote on the previous PR body, with the
// bot's own sections removed, or null when there was nothing of theirs.
//
// The weekly job updates last week's PR in place rather than opening a second
// one, and updating a PR body is a whole-body replace. Without this, a note
// anyone left on that PR would be gone by the next run, and the note is the one
// part of the body a person wrote.
export function carryOverNotes(previous) {
  if (!previous?.trim()) return null;
  const start = previous.indexOf(NOTES_HEADING);
  const kept = start === -1 ? "" : previous.slice(start).trim();
  // A body with none of the bot's sections is a human who replaced the whole
  // thing. That is their text, so it is kept whole rather than treated as stale
  // bot output, otherwise a person rewriting the body loses it.
  const isOurs = BOT_SECTIONS.some((h) => previous.includes(h));
  if (!isOurs) return previous.trim();
  return kept || null;
}

// withNotes appends the carried notes under a heading of their own, so this
// week's ranking reads cleanly and the older note is visibly not part of it.
export function withNotes(body, notes) {
  if (!notes) return body;
  return `${body}\n${NOTES_HEADING}\n\n${notes.replace(NOTES_HEADING, "").trim()}\n`;
}

// renderReport is the PR body: the ranking, the runners-up, and every model
// left out with the reason, so the human can overrule the order on sight.
export function renderReport({ ranked, rejected, current = [], change, cfg = {}, free, generated = new Date().toISOString() }) {
  const { pin, min_context, min_completion_tokens } = settings(cfg);
  const rest = ranked.slice(pin);
  const paid = rejected.filter((r) => r.reason === "no longer free").length;
  const lines = [];
  const list = (items) => items.map((i) => `- \`${i.id}\``).join("\n");

  lines.push("## What this is");
  lines.push("Opened automatically by the weekly refresh, once a week, and never merged on its own. The only edit is the `models` list in `reviewbot.json`: which free models the reviewer tries, in order, before falling back to the `openrouter/free` router.");
  lines.push("No code changes. If the order here is wrong, edit the list by hand and merge, and next week starts from your order instead of this one.");
  lines.push("## Before you merge");
  lines.push("- Does the top of the list look like something you want answering code reviews? That is the whole judgement. The score is OpenRouter's, not a benchmark run here.");
  lines.push("- Anything in **No longer free** needs deleting even if the rest looks fine, or the reviewer keeps spending an attempt on a dead name.");
  lines.push("- A week where nothing changed opens no PR, so silence means the pins still match.");
  lines.push("## This week");
  lines.push(`Fetched ${generated.slice(0, 10)}: ${free} free models, ${ranked.length} of them big enough to review a PR, ${pin} pinned.${paid ? ` ${paid} more are listed but cost money now.` : ""}`);
  lines.push(`A pin must be free, read and write text, have a published coding score, hold at least ${min_context} tokens of context, and allow ${min_completion_tokens} output tokens. Unbenchmarked models are left out: that is where the content-safety classifiers and the tiny models are.`);
  lines.push("Ranked by the coding score OpenRouter publishes. Nobody merged this: look at the order and change it if you disagree.");
  lines.push("## Pinned");
  lines.push(ranked.length ? list(ranked.slice(0, pin)) : "Nothing on the free list qualifies this week. The reviewer falls back to the free router until the next run.");
  if (rest.length) {
    lines.push("## Next in line");
    lines.push("These take over when a pin leaves the free list, and they are what the order is measured against.");
    lines.push(list(rest));
  }
  if (change.gone.length) {
    lines.push("## No longer free");
    lines.push("A pin here is dead weight: the reviewer burns an attempt on it every run.");
    lines.push(list(change.gone));
  }
  if (rejected.length) {
    lines.push("## Left out");
    const byReason = new Map();
    for (const r of rejected) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r.id]);
    for (const [reason, ids] of byReason) lines.push(`- ${reason}: ${ids.map((id) => `\`${id}\``).join(", ")}`);
  }
  if (current.length) {
    lines.push("## Was pinned");
    lines.push(`- kept: ${change.kept.length ? change.kept.map((id) => `\`${id}\``).join(", ") : "none"}`);
    lines.push(`- added: ${change.added.length ? change.added.map((id) => `\`${id}\``).join(", ") : "none"}`);
    lines.push(`- ranked out: ${change.dropped.length ? change.dropped.map((id) => `\`${id}\``).join(", ") : "none"}`);
  }
  return lines.join("\n\n") + "\n";
}
