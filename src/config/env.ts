import { existsSync, readFileSync } from "node:fs";
import { paths } from "./home";

// Load ~/.slaude/.env if present (does not override existing process.env)
function loadDotenv(path: string) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || !m[1]) continue;
    const key: string = m[1];
    let val: string = m[2] ?? "";
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv(paths.env);

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  slack: {
    botToken: () => req("SLACK_BOT_TOKEN"),
    appToken: () => req("SLACK_APP_TOKEN"),
    allowedUsers: () =>
      opt("SLACK_ALLOWED_USERS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
  },
  anthropic: {
    apiKey: () => opt("ANTHROPIC_API_KEY"),
  },
  model: () => opt("SLAUDE_MODEL", "claude-sonnet-4-6"),
};
