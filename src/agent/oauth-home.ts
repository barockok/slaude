/**
 * Per-initiator CLAUDE_CONFIG_DIR isolation for /1on1-locked sessions.
 *
 * The claude-code child the SDK spawns persists MCP OAuth tokens under its
 * CLAUDE_CONFIG_DIR (default ~/.claude: `.credentials.json`,
 * `mcp-needs-auth-cache.json`), keyed by server and reused across runs. slaude's
 * `.mcp.json` credential-strip (clearCredentials) edits config only, so it cannot
 * affect OAuth-authenticated HTTP MCP servers — the token lives in the CLI store,
 * not the config.
 *
 * To run a locked thread "as the initiator", we point the child at the
 * initiator's own config home ($SLAUDE_HOME/oauth/<userId>), pre-authed
 * out-of-band. Every OAuth-requiring HTTP MCP then resolves against the
 * initiator's tokens instead of the agent's. Unlocked sessions inherit the
 * agent's config dir unchanged.
 */
import { mkdirSync, existsSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";

/** The agent's own claude config dir (where its OAuth tokens + plugins live). */
export function agentConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || paths.claudeConfig;
}

/** Persistent per-initiator config home. The initiator's OAuth tokens accumulate
 *  here across all their locked threads (per-initiator, not per-thread). */
export function initiatorConfigDir(userId: string): string {
  return join(paths.home, "oauth", userId);
}

// Credential stores in the agent config dir — never seeded into an initiator
// home (the whole point is the initiator's identity, not the agent's).
const CRED_FILES = [".credentials.json", "mcp-needs-auth-cache.json"];

/** Ensure the initiator's config home exists, seeded with the agent's non-secret
 *  settings + plugins (so the locked session keeps skills/plugins) but NOT its
 *  credentials. Idempotent; also scrubs any pre-existing leaked cred files. */
export function ensureInitiatorConfigDir(userId: string): string {
  const dir = initiatorConfigDir(userId);
  mkdirSync(dir, { recursive: true });

  const src = agentConfigDir();
  // settings.json — copy once (non-secret: enabledPlugins, marketplaces).
  const srcSettings = join(src, "settings.json");
  const dstSettings = join(dir, "settings.json");
  if (existsSync(srcSettings) && !existsSync(dstSettings)) copyFileSync(srcSettings, dstSettings);
  // plugins/ — symlink (read-only share; plugin code lives in the agent home).
  const srcPlugins = join(src, "plugins");
  const dstPlugins = join(dir, "plugins");
  if (existsSync(srcPlugins) && !existsSync(dstPlugins)) {
    try { symlinkSync(srcPlugins, dstPlugins, "dir"); } catch { /* best-effort */ }
  }
  // Defensive: a credential file must never live in the initiator home.
  for (const f of CRED_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  return dir;
}

/** CLAUDE_CONFIG_DIR override for a session given its /1on1 lock state.
 *  Locked → the initiator's isolated home (their OAuth identity).
 *  Unlocked → undefined (caller inherits the agent's config dir). */
export function resolveSessionConfigDir(lockedUser: string | null | undefined): string | undefined {
  if (!lockedUser) return undefined;
  return ensureInitiatorConfigDir(lockedUser);
}
