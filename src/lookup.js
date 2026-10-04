// Reads the repository at the head commit, so a review can check a claim
// against the code instead of guessing. The tree is downloaded once into a
// scratch directory on the runner and read with grep and the filesystem.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gutter, ignored, validLines } from "./diff.js";

const MAX_TREE_BYTES = 200e6;
const MAX_FILE_BYTES = 1e6;

// downloadTree extracts the repository at sha and returns the directory.
export async function downloadTree(token, repo, sha, { maxBytes = MAX_TREE_BYTES } = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/tarball/${sha}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "review-bot" },
  });
  if (!res.ok) throw new Error(`tarball ${res.status}`);
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "tree-"));
  const tar = spawn("tar", ["-xz", "--strip-components=1", "-C", dir], { stdio: ["pipe", "ignore", "ignore"] });
  const exited = new Promise((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _enc, done) {
      bytes += chunk.length;
      done(bytes > maxBytes ? new Error("repository too large to read") : null, chunk);
    },
  });
  try {
    await Promise.all([pipeline(Readable.fromWeb(res.body), cap, tar.stdin), exited]);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

// readFileAt reads a file inside dir. A symlink in a pull request could point
// at the runner's own files, so anything that resolves outside dir is refused.
export function readFileAt(dir, path) {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(join(root, path));
    if (!real.startsWith(root + sep)) return null;
    const st = statSync(real);
    return st.isFile() && st.size <= MAX_FILE_BYTES ? readFileSync(real, "utf8") : null;
  } catch {
    return null;
  }
}

export const textsOf = (text) => new Map(text.split("\n").map((t, i) => [i + 1, t]));

// windowOf renders numbered lines from texts (line number to text) from
// before lines above to after lines below each line in centers, leaving out the
// lines in skip. A marker stands for any gap.
export function windowOf(texts, centers, before = 12, after = before, skip = new Set()) {
  const keep = new Set();
  for (const c of centers) for (let n = c - before; n <= c + after; n++) if (texts.has(n) && !skip.has(n)) keep.add(n);
  const out = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (prev && n > prev + 1) out.push("   ...");
    out.push(gutter(n) + texts.get(n));
    prev = n;
  }
  return out.join("\n");
}

// headContext maps each modified file to its code around the changed lines at
// head, numbered the way the diff is and without the lines the diff already
// shows. A file the pull request adds is already
// shown whole in the diff, so only a modified file is listed, and one that cannot
// be read is null.
export function headContext(dir, files, { ignore_paths = [] } = {}) {
  const out = new Map();
  for (const f of files) {
    if (ignored(f.filename, ignore_paths) || f.status === "removed" || f.status === "added" || !f.patch) continue;
    const text = readFileAt(dir, f.filename);
    out.set(f.filename, text == null ? null : windowOf(textsOf(text), addedLines(f.patch), 20, 20, validLines(f.patch)));
  }
  return out;
}

// addedLines are the new-side line numbers a patch adds.
function addedLines(patch) {
  const lines = [];
  let n = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) n = Number(hunk[1]);
    else if (line.startsWith("+")) lines.push(n++);
    else if (line.startsWith(" ")) n++;
  }
  return lines;
}

// identifiers pulls the names a finding mentions, the quoted ones first. A plain
// word is skipped: it is as likely to be a package, a folder or English as a
// declaration, while a code name carries an underscore or a capital past its
// first letter.
export function identifiers(text, max = 8) {
  const names = new Set();
  const code = (span) => {
    for (const [name] of span.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) if (/_|.[A-Z]/.test(name) && !/^__.*__$/.test(name)) names.add(name);
  };
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) code(span);
  code(text);
  return [...names].slice(0, max);
}

const DECL = "(def|class|function|func|fn|struct|enum|trait|interface|type|const|let|var|val|fun|record|object|impl)";
const MODIFIERS = "((export|pub|public|private|protected|static|async|final|abstract|default|extern|unsafe|override)[[:space:]]+)*";

// definitionsOf finds where each name is declared and shows the lines from
// there on, which is where a signature and its docs sit.
export function definitionsOf(dir, names, { hits = 2, lines = 10, ignore_paths = [] } = {}) {
  const out = [];
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const found = spawnSync(
      "grep",
      ["-rIn", "-E", "--exclude-dir=.git", "--exclude-dir=node_modules", "-e", `^[[:space:]]*${MODIFIERS}${DECL}[[:space:]]+${name}\\b`, "-e", `^[[:space:]]*${name}[[:space:]]*(:[^=]*)?=[^=]`, "."],
      { cwd: dir, encoding: "utf8", timeout: 10000, maxBuffer: 4e6 },
    );
    let shown = 0;
    for (const hit of (found.stdout ?? "").split("\n")) {
      const m = hit.match(/^\.\/(.+?):(\d+):/);
      if (!m || ignored(m[1], ignore_paths) || shown >= hits) continue;
      const text = readFileAt(dir, m[1]);
      if (text == null) continue;
      out.push(`### ${name}, declared in ${m[1]}\n${windowOf(textsOf(text), [Number(m[2])], 0, lines)}`);
      shown++;
    }
  }
  return out;
}
