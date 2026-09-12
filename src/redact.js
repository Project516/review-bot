import { inspect } from "node:util";
import { createHash } from "node:crypto";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// redactor hides every term in a string, longest first so a repo full name is
// replaced before its owner or name halves are.
export function redactor(terms) {
  const parts = [...new Set(terms.filter((t) => typeof t === "string" && t.length > 2))]
    .sort((a, b) => b.length - a.length)
    .map(escape);
  if (!parts.length) return (s) => s;
  const re = new RegExp(parts.join("|"), "gi");
  return (s) => s.replace(re, "[redacted]");
}

// tag is a stable short name for a PR that does not spell out where it lives.
export const tag = (repo, pr) => createHash("sha256").update(`${repo}#${pr}`).digest("hex").slice(0, 8);

// installRedaction rewrites console output in place. This repo's Actions logs
// are public, so the name of the repo under review must never reach them, not
// through a log line and not through an error message or a stack trace.
export function installRedaction(terms) {
  const hide = redactor(terms);
  const render = (a) => hide(typeof a === "string" ? a : a instanceof Error ? (a.stack ?? String(a)) : inspect(a));
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(...args.map(render));
  }
}
