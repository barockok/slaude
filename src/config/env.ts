import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { paths } from "./home";

// Load a .env file if present (does not override existing process.env)
export function loadDotenv(path: string) {
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

/** Parse a duration: a bare number of seconds, or a number with an `s`, `m`,
 *  `h` or `d` suffix. Returns null for anything else or a non-positive value. */
export function parseDurationSec(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)([smhd]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as const)[m[2] as "" | "s" | "m" | "h" | "d"];
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Boot check for the job-token caps: each set value must parse. Messages name
 *  the variable. A bad value would otherwise surface as a 500 on every token
 *  refresh and reissue. */
export function jobAgeEnvViolations(e: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const name of ["SLAUDE_JOB_TOKEN_MAX_AGE", "SLAUDE_JOB_MAX_AGE"]) {
    const raw = (e[name] ?? "").trim();
    if (raw && parseDurationSec(raw) === null) {
      out.push(`${name} must be a positive number of seconds or a duration like 6h (got '${raw}')`);
    }
  }
  return out;
}

function durationEnvSec(name: string, dflt: number): number {
  const raw = opt(name).trim();
  if (!raw) return dflt;
  const n = parseDurationSec(raw);
  if (n === null) throw new Error(`${name} must be seconds or a duration like 6h (got '${raw}')`);
  return n;
}

/** Split a comma-separated env list into trimmed, non-empty entries. */
function csv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** A pipeline token equal to the node token is treated as unset: every node
 *  holds the node token, so the pipeline credential would be on every node.
 *  Warns once per variable; the message names the variable, never a value. */
const warnedSameAsNode = new Set<string>();
function sameAsNodeToken(token: string, name: string): boolean {
  // SLAUDE_NODE_TOKEN is what a node presents; SLAUDE_NODE_LEGACY_TOKEN is the
  // gateway's copy of the shared token every legacy node presents as its own.
  for (const nodeVar of ["SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY_TOKEN"]) {
    const node = (opt(nodeVar) ?? "").trim();
    if (!node || token !== node) continue;
    if (!warnedSameAsNode.has(name)) {
      warnedSameAsNode.add(name);
      console.warn(`[deploy] ${name} equals ${nodeVar}, which every node holds; treating ${name} as unset`);
    }
    return true;
  }
  return false;
}
/** Test helper: let the same-as-node-token warning fire again. */
export function __resetDeployTokenWarnings() { warnedSameAsNode.clear(); }

export const env = {
  slack: {
    /**
     * Slack ingress mode (spec §5 / milestone M3):
     *   socket (default) — Bolt Socket Mode, single app from SLACK_BOT_TOKEN.
     *   http             — Events API receiver on SLAUDE_HTTP_PORT, apps
     *                      resolved per-request from the Postgres slack_apps
     *                      registry (requires SLAUDE_DB=pg + SLAUDE_MASTER_KEY).
     */
    mode: (): "socket" | "http" => {
      const raw = opt("SLAUDE_SLACK_MODE", "socket").trim().toLowerCase();
      if (raw !== "socket" && raw !== "http") {
        throw new Error(`SLAUDE_SLACK_MODE must be 'socket' or 'http' (got '${raw}')`);
      }
      return raw;
    },
    /**
     * Listen port for the HTTP Slack transport (default 8080). In http mode
     * this single port also serves /healthz, /readyz and /metrics — the
     * standalone SLAUDE_HEALTH_PORT server is not started.
     */
    httpPort: (): number => {
      const raw = opt("SLAUDE_HTTP_PORT", "8080");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`SLAUDE_HTTP_PORT must be a port number (got '${raw}')`);
      }
      return n;
    },
    /**
     * Max accepted request-body size on /slack/* (bytes, default 1_000_000).
     * Oversize requests are refused with 413 before signature verification.
     * Slack event payloads are far below 1MB; raise only if a custom proxy
     * inflates envelopes.
     */
    httpMaxBodyBytes: (): number => {
      const raw = opt("SLAUDE_HTTP_MAX_BODY_BYTES", "1000000");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`SLAUDE_HTTP_MAX_BODY_BYTES must be a positive integer (got '${raw}')`);
      }
      return n;
    },
    /**
     * Override for the Slack Web API base URL. Unset (the default) means the
     * SDK's own https://slack.com/api/. Used by the end-to-end suite to point the
     * gateway at a fake Slack; production never sets it. Normalised to end in "/"
     * because the SDK appends the method name directly.
     */
    apiUrl: (): string | undefined => {
      const raw = opt("SLAUDE_SLACK_API_URL", "").trim();
      if (!raw) return undefined;
      return raw.endsWith("/") ? raw : `${raw}/`;
    },
    botToken: () => req("SLACK_BOT_TOKEN"),
    appToken: () => req("SLACK_APP_TOKEN"),
    /**
     * OAuth install flow (spec §5 model B, one app installed to many
     * workspaces). Setting SLACK_CLIENT_ID enables GET /slack/oauth/start +
     * /slack/oauth/callback on the HTTP transport; unset, both 404. The
     * client secret signs the `state` token (shared across gateway replicas,
     * so a state minted on one replica verifies on another) and authenticates
     * the oauth.v2.access code exchange.
     */
    clientId: () => opt("SLACK_CLIENT_ID").trim(),
    clientSecret: () => opt("SLACK_CLIENT_SECRET").trim(),
    /** App-level signing secret stored on each OAuth-installed slack_apps row
     *  (oauth.v2.access does not return it — it is app config, identical for
     *  every workspace the app is installed to). */
    signingSecret: () => opt("SLACK_SIGNING_SECRET").trim(),
    /** Fixed redirect_uri registered on the Slack app. Empty → Slack uses the
     *  app's sole configured redirect URL (and no redirect_uri param is sent). */
    oauthRedirectUrl: () => opt("SLACK_OAUTH_REDIRECT_URL").trim(),
    /** Dedicated HMAC secret for the OAuth install `state` (must be identical
     *  on every gateway replica). Empty → the flow falls back to
     *  SLACK_CLIENT_SECRET with a one-line warning. */
    oauthStateSecret: () => opt("SLAUDE_OAUTH_STATE_SECRET").trim(),
    /**
     * Optional user token (xoxp). Historically used only for presence
     * (`users.profile.set`). Also the token used for post-as-user when
     * SLACK_POST_AS_USER is enabled.
     */
    userToken: () => opt("SLACK_USER_TOKEN"),
    /**
     * Opt-in: when "true" AND a user token is set, the agent posts/edits/reacts/
     * uploads AS the real Slack user (its own account) rather than the app bot.
     * App-bound interactivity (permission/approval gate buttons) always stays on
     * the bot token. Default off — existing deploys that set SLACK_USER_TOKEN
     * for presence keep posting as the bot, unchanged.
     *
     * The user token must carry write scopes (chat:write, reactions:write,
     * files:write) and, because reads also route through it in this mode, read
     * scopes (channels:history, groups:history, im:history, users:read).
     */
    postAsUser: () => opt("SLACK_POST_AS_USER").trim().toLowerCase() === "true",
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
  db: {
    /** Bun.sql connection pool size for SLAUDE_DB=pg (default 10). */
    pgPool: () => {
      const raw = opt("SLAUDE_PG_POOL", "10");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`SLAUDE_PG_POOL must be a positive integer (got '${raw}')`);
      }
      return n;
    },
    /** Seconds a booting replica waits for the migration advisory lock.
     *  0 (default) = wait forever; > 0 fails the boot loudly on expiry. */
    migrateLockTimeoutSec: () => {
      const raw = opt("SLAUDE_MIGRATE_LOCK_TIMEOUT_SEC", "0");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`SLAUDE_MIGRATE_LOCK_TIMEOUT_SEC must be a non-negative integer (got '${raw}')`);
      }
      return n;
    },
    /** Run pending src/db/migrations/*.sql on every boot. Default on — this
     *  is what makes a fresh Postgres usable with no separate migrate step.
     *  Turn off only where migrations are applied out-of-band (a dedicated
     *  migrate job ahead of the rollout) and every replica skipping the
     *  advisory-lock wait on boot is worth the coordination it removes. */
    migrateOnBoot: () => {
      const raw = opt("SLAUDE_MIGRATE_ON_BOOT", "1").trim().toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
  },

  /**
   * Process role for the horizontal-scale split (spec §7):
   *   mono    (default) — today's single-process behavior; mounts /v1 for parity
   *   gateway — Slack ingress + control plane; mounts /v1 for nodes
   *   node    — queue worker; never mounts /v1 (it *calls* /v1)
   * Unknown values fall back to mono so existing deploys are unchanged.
   */
  role: (): "mono" | "gateway" | "node" => {
    const raw = opt("SLAUDE_ROLE", "mono").trim().toLowerCase();
    return raw === "gateway" || raw === "node" ? raw : "mono";
  },
  /** Static shared secret nodes present as `Authorization: Bearer <token>` on
   *  every /v1 request. Empty (default) = /v1 auth refuses all requests, so a
   *  mono deploy without the var exposes nothing. Rotate via env. */
  nodeToken: () => opt("SLAUDE_NODE_TOKEN"),
  /** Gateway: HS256 key for signed node credentials (WS-B §4.1). Its own key,
   *  never the job secret. Empty = signed credentials are not accepted. */
  nodeKey: () => opt("SLAUDE_NODE_KEY"),
  /** Gateway: the previous node key, still accepted when verifying so a key
   *  rotates without a flag day. */
  nodeKeyPrevious: () => opt("SLAUDE_NODE_KEY_PREVIOUS"),
  /** Gateway: the static shared token a legacy node presents. Falls back to
   *  SLAUDE_NODE_TOKEN (the old gateway reading, deprecated) when unset. */
  nodeLegacyToken: () => opt("SLAUDE_NODE_LEGACY_TOKEN"),
  /** Gateway: SLAUDE_NODE_LEGACY=off closes the legacy door outright. */
  nodeLegacyOff: (): boolean => opt("SLAUDE_NODE_LEGACY").trim().toLowerCase() === "off",
  /** Gateway: accept a /v1/pending call with no job token from the legacy
   *  identity (old nodes send none). Default on for one release. */
  allowTokenlessPending: (): boolean => {
    const raw = opt("SLAUDE_NODE_ALLOW_TOKENLESS_PENDING", "1").trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  },
  /** Cap on a job token's total life across refreshes, measured from its
   *  first issue (`iat0`). Seconds, or a duration like `6h`. Default 6h. */
  jobTokenMaxAgeSec: (): number => durationEnvSec("SLAUDE_JOB_TOKEN_MAX_AGE", 6 * 3600),
  /** Cap on a job's total age for token-reissue. Default 24h. */
  jobMaxAgeSec: (): number => durationEnvSec("SLAUDE_JOB_MAX_AGE", 24 * 3600),
  /** How long a label in use may have waiting jobs and no live node before it
   *  is reported unserved (node labels spec §4.7). Default 60s. */
  labelUnservedSec: (): number => durationEnvSec("SLAUDE_LABEL_UNSERVED_SECS", 60),
  /** Pipeline credential for /deploy. Unset → /deploy does not exist. Never the
   *  node token: every node holds that one, and "nodes can't change identity"
   *  is the point of this endpoint having its own. Returned TRIMMED, and ""
   *  (treated as unset, so /deploy 404s) when the trimmed value is under 32
   *  characters: a blank or trivially short token must never count as configured. */
  deployToken: () => {
    const t = (opt("SLAUDE_DEPLOY_TOKEN") ?? "").trim();
    if (t.length < 32) return "";
    return sameAsNodeToken(t, "SLAUDE_DEPLOY_TOKEN") ? "" : t;
  },
  /** Dry-run-only pipeline credential for /deploy, for pull-request jobs: it is
   *  accepted only with `?dryRun=1`, so a PR workflow holding it can preview a
   *  sync but never apply one. Same trim and 32-character floor as the deploy
   *  token; a value equal to the deploy token is "" (unset), since it would
   *  then be an apply credential under a preview name. */
  deployPreviewToken: () => {
    const t = (opt("SLAUDE_DEPLOY_PREVIEW_TOKEN") ?? "").trim();
    if (t.length < 32) return "";
    const d = (opt("SLAUDE_DEPLOY_TOKEN") ?? "").trim();
    if (t === d) return "";
    return sameAsNodeToken(t, "SLAUDE_DEPLOY_PREVIEW_TOKEN") ? "" : t;
  },
  /** HS256 secret for the short-lived per-job JWT (`X-Slaude-Job`) minted by
   *  the gateway enqueue path and verified on tool-plane + session endpoints.
   *  Empty (default) = job tokens can be neither minted nor verified. */
  jobSecret: () => opt("SLAUDE_JOB_SECRET"),
  /** Gateway base URL a node worker calls for /v1 (spec §6). */
  gatewayUrl: () => opt("SLAUDE_GATEWAY_URL", "http://localhost:8080"),
  /** Node /healthz + /metrics port (spec §6). Default 8081; 0 disables. */
  nodePort: (): number => {
    const raw = opt("SLAUDE_NODE_PORT", "8081");
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`SLAUDE_NODE_PORT must be a port number (got '${raw}')`);
    }
    return n;
  },
  /**
   * SLAUDE_PROVIDER_ENV_FALLBACK (node, WS-A §5.4). `1` (default): a managed
   * persona whose bundle lacks a provider variable runs on the node's own,
   * with a one-time warning per persona. `0`: those variables are removed from
   * the agent child's environment, and a managed persona with no credential
   * fails its turn with PROVIDER_CREDENTIALS_UNAVAILABLE. Anything else is a
   * configuration error, so a typo never silently means "fall back".
   */
  providerEnvFallback: (): boolean => {
    const raw = opt("SLAUDE_PROVIDER_ENV_FALLBACK", "1").trim();
    if (raw !== "0" && raw !== "1") {
      throw new Error(`SLAUDE_PROVIDER_ENV_FALLBACK must be 0 or 1 (got '${raw}')`);
    }
    return raw === "1";
  },
  /** BullMQ worker concurrency per node process (spec §6). Default 8. */
  nodeConcurrency: (): number => {
    const raw = opt("SLAUDE_NODE_CONCURRENCY", "8");
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`SLAUDE_NODE_CONCURRENCY must be a positive integer (got '${raw}')`);
    }
    return n;
  },

  /**
   * Session-lock timings (spec §2). The TTL is also the takeover delay: a
   * killed node never releases `lock:session:<id>`, so the turn re-delivered to
   * another node waits for the lock to expire before it can run. The default
   * tolerates a ten-minute stall inside a live node and costs that long a
   * takeover when one dies; a deployment that prefers fast takeover lowers
   * both. The TTL must stay comfortably above the renewal cadence, or a live
   * node's lock could lapse between renewals and its session change hands
   * mid-turn.
   */
  sessionLock: (): { ttlMs: number; extendEveryMs: number } => {
    const ms = (name: string, dflt: number): number => {
      const raw = opt(name, String(dflt));
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${name} must be a positive integer of milliseconds (got '${raw}')`);
      }
      return n;
    };
    const extendEveryMs = ms("SLAUDE_SESSION_LOCK_EXTEND_MS", 60_000);
    const ttlMs = ms("SLAUDE_SESSION_LOCK_TTL_MS", 600_000);
    if (ttlMs < extendEveryMs * 3) {
      throw new Error(
        `SLAUDE_SESSION_LOCK_TTL_MS (${ttlMs}) must be at least 3x ` +
          `SLAUDE_SESSION_LOCK_EXTEND_MS (${extendEveryMs}), so a renewal that is late ` +
          `does not cost a live node its session`,
      );
    }
    return { ttlMs, extendEveryMs };
  },

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
  /**
   * Session control panel (operator web surface, gateway-tier only). Mounts
   * `/panel/*` on the gateway Bun.serve when enabled and the role is not
   * `node`. The panel is its own OIDC relying party: it authenticates the
   * operator against a single issuer and mints its own session tokens. It
   * stores no operator records — roles come from `rolesFile` or the env lists.
   */
  panel: {
    /** Enable the panel surface. Default off. */
    enabled: () => {
      const raw = opt("SLAUDE_PANEL", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
    /** OIDC issuer URL; endpoints are read from its discovery document. */
    oidcIssuer: () => opt("SLAUDE_PANEL_OIDC_ISSUER").trim().replace(/\/+$/, ""),
    oidcClientId: () => opt("SLAUDE_PANEL_OIDC_CLIENT_ID").trim(),
    oidcClientSecret: () => opt("SLAUDE_PANEL_OIDC_CLIENT_SECRET"),
    /** Public base URL of this panel; the redirect URI is derived from it and
     *  must match the provider registration exactly. */
    publicUrl: () => opt("SLAUDE_PANEL_PUBLIC_URL").trim().replace(/\/+$/, ""),
    /** HMAC key for the session and flow cookies. */
    secret: () => opt("SLAUDE_PANEL_SECRET"),
    /** Which ID-token claim becomes the operator identity. */
    userClaim: () => opt("SLAUDE_PANEL_USER_CLAIM", "email").trim(),
    /** Role list file; empty string means "use $SLAUDE_HOME/panel-roles.yaml". */
    rolesFile: () => opt("SLAUDE_PANEL_ROLES_FILE").trim(),
    /** Env fallbacks used only when the roles file is absent. */
    superadmins: () => csv(opt("SLAUDE_PANEL_SUPERADMIN")),
    operators: () => csv(opt("SLAUDE_PANEL_OPERATORS")),
  },
  portal: {
    /** Enable the end-user onboarding portal. Default off. It reuses the
     *  panel's OIDC client, public URL and signing secret on purpose: one
     *  deployment, one provider registration, one secret. */
    enabled: () => {
      const raw = opt("SLAUDE_PORTAL", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
  },
  remote: {
    /** `/remote` — run a thread's shell and file tools on the initiator's own
     *  machine over tailcat SSH. Default off; ships behind this flag. */
    enabled: () => {
      const raw = opt("SLAUDE_REMOTE", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
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
  /** Fixed redirect_uri for /mcp OAuth in paste-back mode. When set, slaude does
   *  NOT bind a loopback listener — it registers this URL as the redirect, the
   *  IdP sends the browser here (an operator-hosted static page that shows the
   *  code + a "paste this back into Slack" instruction), and the initiator pastes
   *  the callback URL/code into the locked thread. Required for k8s / remote
   *  deploys where an ephemeral loopback port isn't reachable. Empty → loopback. */
  oauthRedirectUrl: () => opt("SLAUDE_OAUTH_REDIRECT_URL", ""),
  /** Public base URL the shared loopback advertises as its redirect_uri (e.g.
   *  "https://auth.example.com"). In-cluster the listener binds a
   *  private port but the IdP must redirect the user's browser to a publicly
   *  routable host fronted by an ingress; this is that host. The callbackPath is
   *  appended. Empty → the loopback falls back to http://localhost:<port>. */
  oauthPublicUrl: () => opt("SLAUDE_OAUTH_PUBLIC_URL", "").trim(),
  /** Loopback bind host for the /mcp OAuth callback. 127.0.0.1 locally; set
   *  0.0.0.0 in-container so a `docker -p` mapped port is reachable from the host. */
  oauthLoopbackHost: () => opt("SLAUDE_OAUTH_LOOPBACK_HOST", "127.0.0.1"),
  /** Inclusive port range "a-b" the container pre-maps with `-p`. Empty → ephemeral
   *  (port 0); the connect flow picks the first free port in the range otherwise. */
  oauthLoopbackPorts: (): number[] => {
    const raw = opt("SLAUDE_OAUTH_LOOPBACK_PORTS", "").trim();
    const m = raw.match(/^(\d+)-(\d+)$/);
    if (!m) return [];
    const lo = parseInt(m[1]!, 10), hi = parseInt(m[2]!, 10);
    const out: number[] = [];
    for (let p = lo; p <= hi; p++) out.push(p);
    return out;
  },
  /** Use the always-on shared loopback (one fixed port, flows demuxed by signed
   *  state) instead of a fresh ephemeral listener per connect. Lets many sessions
   *  authorize concurrently behind a single pre-mapped port. Default off. */
  oauthSharedLoopback: (): boolean => /^(1|true|yes)$/i.test(opt("SLAUDE_OAUTH_SHARED_LOOPBACK", "").trim()),
  /** Fixed port for the shared loopback callback server (default 3118 — the same
   *  port the claude CLI uses). Only meaningful when oauthSharedLoopback is on. */
  oauthSharedLoopbackPort: (): number => {
    const n = parseInt(opt("SLAUDE_OAUTH_SHARED_LOOPBACK_PORT", "3118").trim(), 10);
    return Number.isFinite(n) ? n : 3118;
  },
  /** HMAC secret signing the session id inside the OAuth `state`. Empty → a random
   *  per-process secret (fine: the shared listener lives for the process lifetime,
   *  so in-flight states stay verifiable; a restart invalidates pending flows). */
  oauthStateSecret: (): string => {
    const set = opt("SLAUDE_OAUTH_STATE_SECRET", "").trim();
    if (set) return set;
    if (!ephemeralStateSecret) ephemeralStateSecret = randomBytes(32).toString("base64url");
    return ephemeralStateSecret;
  },
};

let ephemeralStateSecret = "";
