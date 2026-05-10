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
    /**
     * Slack user IDs allowed to approve / deny `request_approval` plans.
     * Falls back to `SLACK_ALLOWED_USERS` (everyone the bot can talk to)
     * when unset. Empty list = approval gate accepts any user — useful
     * only for solo / DM workspaces.
     */
    approvers: () => {
      const raw = opt("SLAUDE_APPROVERS");
      const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length) return list;
      return opt("SLACK_ALLOWED_USERS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    },
  },
  /**
   * Anthropic-compatible LLM provider. Any provider that speaks the Anthropic
   * Messages API works (Anthropic, OpenRouter, Z.ai, self-hosted gateway, etc.).
   *
   *   ANTHROPIC_BASE_URL  optional; defaults to https://api.anthropic.com
   *   ANTHROPIC_API_KEY   required
   *   SLAUDE_MODEL        provider-qualified model id
   *   ANTHROPIC_AUTH_TOKEN optional; used by some gateways instead of API key header
   */
  provider: {
    apiKey: () => opt("ANTHROPIC_API_KEY"),
    baseUrl: () => opt("ANTHROPIC_BASE_URL"),
    authToken: () => opt("ANTHROPIC_AUTH_TOKEN"),
  },
  model: () => opt("SLAUDE_MODEL", "claude-sonnet-4-6"),
  /**
   * Default permission mode for new sessions. One of:
   *   default | acceptEdits | bypassPermissions | plan | dontAsk
   * Aliases (ask=default, bypass=bypassPermissions, accept-edits=acceptEdits,
   * yolo=bypassPermissions) are normalized.
   */
  defaultPermissionMode: () => {
    const raw = opt("SLAUDE_DEFAULT_MODE", "default").toLowerCase();
    const map: Record<string, string> = {
      ask: "default",
      default: "default",
      "accept-edits": "acceptEdits",
      acceptedits: "acceptEdits",
      edits: "acceptEdits",
      plan: "plan",
      bypass: "bypassPermissions",
      yolo: "bypassPermissions",
      bypasspermissions: "bypassPermissions",
      "dont-ask": "dontAsk",
      dontask: "dontAsk",
      deny: "dontAsk",
    };
    return map[raw] ?? "default";
  },
  /**
   * Idle timeout in minutes. After a session sees no new user message for
   * this long, the SDK Query is closed; the next inbound msg in the same
   * thread boots a fresh Query with `resume: <session-id>`. Default 15.
   * Set to 0 to disable (sessions live forever).
   */
  idleMs: () => {
    const raw = opt("SLAUDE_IDLE_MINUTES", "15");
    const n = Number(raw);
    const min = Number.isFinite(n) && n >= 0 ? n : 15;
    return min * 60 * 1000;
  },
};
