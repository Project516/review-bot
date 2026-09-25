import { readFileSync } from "node:fs";

// Who the bot works for lives in the REVIEWBOT_POLICY secret, not in this public
// repo: naming the accounts and people it reviews would defeat the point of a
// private review. reviewbot.json carries only settings that give nothing away.
// Without the secret the lists are empty and nothing is reviewed.
const IDENTITY = { owner: "", allowed_repo_owners: [], allowed_authors: [] };

export function loadConfig(path = new URL("../reviewbot.json", import.meta.url), env = process.env) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  const policy = env.REVIEWBOT_POLICY ? JSON.parse(env.REVIEWBOT_POLICY) : {};
  return { ...IDENTITY, ...file, ...policy };
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
