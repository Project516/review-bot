// A second, narrow pass over the comments a review is about to post. The first
// pass reads the whole diff and writes comments; this one reads each comment next
// to the code at its line and the declarations the repository holds for the
// names it mentions, and drops what that code contradicts or what rests on a fact
// nobody showed. A review that cannot be checked is never allowed to block a merge.
import { lineTexts } from "./diff.js";
import { definitionsOf, identifiers, readFileAt, textsOf, windowOf } from "./lookup.js";
import { rotate } from "./models.js";
import { complete } from "./openrouter.js";
import { buildVerifyMessages, parseVerdicts } from "./prompt.js";

// excerptOf is the head-commit code around a comment's line, from the tree when
// it was read and from the patch otherwise.
function excerptOf(comment, dir, patches) {
  if (!Number.isFinite(comment.line)) return "";
  const text = dir ? readFileAt(dir, comment.path) : null;
  const texts = text == null ? lineTexts(patches.get(comment.path)) : textsOf(text);
  return windowOf(texts, [comment.line], 10);
}

// definitionsFor are the declarations of the names one comment mentions, within
// room characters. Each comment gets its own, so a comment late in the list is
// not left without any.
function definitionsFor(comment, dir, ignore_paths, room) {
  if (!dir) return [];
  const out = [];
  for (const block of definitionsOf(dir, identifiers(comment.body, 4), { ignore_paths })) {
    if (block.length > room) break;
    out.push(block);
    room -= block.length;
  }
  return out;
}

// verify returns the comments that survive the audit. It throws when no model
// produced a usable audit, and the caller decides what an unchecked review may do.
export async function verify({ comments, files, dir, cfg, apiKey, log, run = complete }) {
  const patches = new Map(files.map((f) => [f.filename, f.patch]));
  const room = Math.floor((cfg.max_verify_chars ?? 12000) / Math.max(1, comments.length));
  const findings = comments.map((c) => ({ ...c, excerpt: excerptOf(c, dir, patches), definitions: definitionsFor(c, dir, cfg.ignore_paths, room) }));
  const { value } = await run({
    apiKey,
    models: rotate(cfg.models, cfg.model_runners_up ?? [], cfg),
    messages: buildVerifyMessages({ findings }),
    accept: (text) => parseVerdicts(text, comments.length),
    maxTokens: cfg.max_output_tokens,
    attempts: 3,
    log,
  });
  log(`verify: kept ${value.filter(Boolean).length} of ${comments.length} comments, ${findings.reduce((n, f) => n + f.definitions.length, 0)} declarations shown`);
  return comments.filter((_, i) => value[i]);
}
