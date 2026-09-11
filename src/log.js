// This repo's Actions log is public; the repos it reviews are not. Everything
// the reviewer prints goes through a redactor built from the job, so a log line
// reads "<repo>" and "<author>" instead of naming a private repo or a person.
// The anonymous handle for a repo is job.ref, computed by the Worker.
export function redactor(job) {
  const [owner, name] = String(job.repo ?? "").split("/");
  const subs = new Map();
  for (const [value, placeholder] of [
    [job.repo, "<repo>"],
    [owner, "<owner>"],
    [name, "<name>"],
    [job.author, "<author>"],
    [job.sender, "<sender>"],
  ]) {
    const v = typeof value === "string" ? value.toLowerCase() : "";
    if (v.length > 1 && !subs.has(v)) subs.set(v, placeholder);
  }

  if (subs.size === 0) return { scrub: String, log: (m) => console.log(m) };

  // Longest first, so "owner/name" wins over "owner" in the alternation.
  const pattern = [...subs.keys()]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"))
    .join("|");
  const rx = new RegExp(pattern, "gi");
  const scrub = (text) => String(text).replace(rx, (m) => subs.get(m.toLowerCase()) ?? m);
  return { scrub, log: (m) => console.log(scrub(m)) };
}
