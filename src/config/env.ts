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
    /**
     * Env-level fallback approver allowlist. Used only when SOUL.md has no
     * `## Approvers` section. Empty list = approval gate accepts any user —
     * useful only for solo / DM workspaces.
     */
    approvers: () =>
      opt("SLAUDE_APPROVERS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
  },
  /**
   * Anthropic-compatible LLM provider. Any provider that speaks the Anthropic
   * Messages API works (Anthropic, OpenRouter, Z.ai, self-hosted gateway, etc.).
   *
   *   ANTHROPIC_BASE_URL      optional; defaults to https://api.anthropic.com
   *   ANTHROPIC_API_KEY       required when not using OAuth
   *   SLAUDE_MODEL            provider-qualified model id
   *   ANTHROPIC_AUTH_TOKEN    optional; used by some gateways instead of API key header
   *   CLAUDE_CODE_OAUTH_TOKEN optional; Claude Pro/Max subscription OAuth token
   *                            (produced by `claude setup-token`). When set, the
   *                            extractor uses Authorization: Bearer + the
   *                            anthropic-beta: oauth-2025-04-20 header, and the
   *                            SDK child inherits the token for subscription auth.
   */
  provider: {
    apiKey: () => opt("ANTHROPIC_API_KEY"),
    baseUrl: () => opt("ANTHROPIC_BASE_URL"),
    authToken: () => opt("ANTHROPIC_AUTH_TOKEN"),
    oauthToken: () => opt("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  /**
   * Optional model override. Empty = let the Claude Code SDK / CLI pick its
   * own default model for the current auth mode. Required when pointing at
   * a non-Anthropic gateway (OpenRouter, Z.ai, self-hosted) — those endpoints
   * don't honour Anthropic's default model id, so you MUST set a
   * provider-qualified model id here. When using CLAUDE_CODE_OAUTH_TOKEN, you
   * usually want to leave this unset and inherit Claude Code's subscription
   * default; set it only to pin a specific tier-allowed model.
   */
  model: () => opt("SLAUDE_MODEL"),
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
  /**
   * Auto-evolve after each substantial user turn. When enabled, the manager
   * injects an internal `<auto-evolve>` prompt to make the agent decide
   * whether to save/refine a skill — independent of whether the persona
   * obeys the baseline directive. Set to "0" to disable.
   */
  autoEvolve: () => opt("SLAUDE_AUTO_EVOLVE", "1") !== "0",
  /**
   * Git repo URL where runtime-created skills are pushed by the
   * mcp__slaude_skills__sync_manifest tool. Accepts "github:owner/repo"
   * shorthand or full https/ssh URL. If unset, sync_manifest records
   * skills as local-only entries (survive on PVC only).
   */
  skillsRepo: () => opt("SLAUDE_SKILLS_REPO"),
  /**
   * Context-window thresholds (fraction 0..1). On each turn's result the
   * manager compares `total_input_tokens / contextWindow` against these:
   *   - `warnPct`  (default 0.8): emit a one-shot warning event so the
   *      transport can surface "context filling up" to the user.
   *   - `criticalPct` (default 0.92): emit a higher-severity event. Set to 0
   *      to disable the critical tier.
   * Each crossing fires once per session; resets only on session teardown.
   */
  tokenWarnPct: () => {
    const n = Number(opt("SLAUDE_TOKEN_WARN_PCT", "0.8"));
    return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.8;
  },
  tokenCriticalPct: () => {
    const raw = opt("SLAUDE_TOKEN_CRITICAL_PCT", "0.92");
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0.92;
    if (n <= 0) return 0;
    if (n >= 1) return 0.92;
    return n;
  },
  /**
   * Fallback context-window size (tokens) used when the SDK `result` message
   * has no `modelUsage` entries to source the model's advertised cap from.
   * Override via `SLAUDE_FALLBACK_CONTEXT_WINDOW` (e.g. `1000000` for 1M-ctx
   * models). Defaults to 200000. Non-positive / non-finite values fall back
   * to the default.
   */
  tokenFallbackContextWindow: () => {
    const raw = opt("SLAUDE_FALLBACK_CONTEXT_WINDOW", "200000");
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 200_000;
  },
  /** Static Prometheus labels applied to every metric, e.g.
   *  `SLAUDE_METRICS_LABELS="agent=hermes,env=prod"`. Malformed entries are
   *  silently dropped by the metrics registry. */
  metricsLabels: () => opt("SLAUDE_METRICS_LABELS", ""),
  /** Opt in to per-user turn counters (`slaude_user_turns_total`). Off by
   *  default to avoid high-cardinality blow-up in public channels. */
  metricsPerUser: () => {
    const raw = opt("SLAUDE_METRICS_PER_USER", "0").toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  },
};
