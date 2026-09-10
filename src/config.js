import { readFileSync } from "node:fs";

export function loadConfig(path = new URL("../reviewbot.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
