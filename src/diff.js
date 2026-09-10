// Helpers over the /pulls/:n/files response: which files to skip, which
// new-side line numbers exist in a patch, and how to render the diff inside
// a character budget.

export function ignored(path, patterns = []) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return patterns.some((pat) => {
    if (pat.endsWith("/")) return path.startsWith(pat) || path.includes(`/${pat}`);
    if (pat.startsWith("*")) return path.endsWith(pat.slice(1));
    return path === pat || base === pat;
  });
}

// validLines lists the RIGHT-side line numbers a review comment may attach to:
// added and context lines in the patch's hunks.
export function validLines(patch) {
  const lines = new Set();
  if (!patch) return lines;
  let n = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      lines.add(n);
      n++;
    }
  }
  return lines;
}

// renderDiff produces the markdown the model reads plus the list of files it
// did not get to see and why.
export function renderDiff(files, { ignore_paths = [], max_diff_chars = 60000 } = {}) {
  const perFile = Math.floor(max_diff_chars / 3);
  const omitted = [];
  let text = "";
  let budget = max_diff_chars;

  for (const f of files) {
    if (ignored(f.filename, ignore_paths)) {
      omitted.push({ path: f.filename, reason: "ignored path" });
      continue;
    }
    if (!f.patch) {
      omitted.push({ path: f.filename, reason: `${f.status}, no text diff` });
      continue;
    }
    const header = `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n`;
    let patch = f.patch;
    if (patch.length > perFile) patch = `${patch.slice(0, perFile)}\n... (truncated)`;
    const block = `${header}\`\`\`diff\n${patch}\n\`\`\`\n\n`;
    if (block.length > budget) {
      omitted.push({ path: f.filename, reason: "diff budget exhausted" });
      continue;
    }
    text += block;
    budget -= block.length;
  }
  return { text, omitted };
}
