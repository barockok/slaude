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
import { mkdirSync, existsSync, lstatSync, readlinkSync, unlinkSync, copyFileSync, symlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/home";

/** The agent's own claude config dir (where its OAuth tokens + plugins live).
 *  Falls back to `~/.claude` — the CLI's built-in default — so the projects/
 *  symlink in initiator dirs always targets the same location as unlocked sessions. */
export function agentConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Seed a config dir with the non-secret settings + plugins from `src` (copy
 *  settings once, symlink plugins read-only). Never touches credential stores. */
function seedConfigDir(dir: string, src: string): void {
  // settings.json + settings.local.json — copy once (non-secret: enabledPlugins,
  // marketplaces, local overrides). Never copy credential stores: the whole point
  // is an isolated identity, and this dir HOLDS its own .credentials.json.
  for (const name of ["settings.json", "settings.local.json"]) {
    const s = join(src, name);
    const d = join(dir, name);
    if (existsSync(s) && !existsSync(d)) copyFileSync(s, d);
  }
  // plugins/ — symlink (read-only share; plugin code lives in the agent home).
  const srcPlugins = join(src, "plugins");
  const dstPlugins = join(dir, "plugins");
  if (existsSync(srcPlugins) && !existsSync(dstPlugins)) {
    try { symlinkSync(srcPlugins, dstPlugins, "dir"); } catch { /* best-effort */ }
  }
}

/** A named persona's config home: personas/<name>/.claude. Carries the persona's
 *  own .credentials.json (MCP OAuth tokens) AND its own projects/ transcript tree,
 *  keeping both isolated from other personas and the global agent. */
export function personaConfigDir(personaName: string): string {
  return join(paths.personas, personaName, ".claude");
}

/** Ensure a persona config home exists, seeded from the global agent home. Unlike
 *  an initiator home, projects/ here is a REAL directory (the persona's own
 *  transcript store), not a symlink — this is what isolates the sessions dir. */
export function ensurePersonaConfigDir(personaName: string): string {
  const dir = personaConfigDir(personaName);
  mkdirSync(dir, { recursive: true });
  seedConfigDir(dir, agentConfigDir());
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
}

/** Persistent per-initiator config home. The initiator's OAuth tokens accumulate
 *  here across all their locked threads (per-initiator, not per-thread). When a
 *  named persona owns the session, the home nests under the persona so isolation
 *  is per-(persona × user): oauth/<persona>/<userId>. */
export function initiatorConfigDir(userId: string, personaName?: string): string {
  const persona = personaName && personaName !== "default" ? personaName : null;
  return persona
    ? join(paths.home, "oauth", persona, userId)
    : join(paths.home, "oauth", userId);
}

/** Ensure the initiator's config home exists, seeded with the non-secret settings
 *  + plugins of its base home (so the locked session keeps skills/plugins).
 *  Idempotent. The initiator's own .credentials.json (written by the /mcp connect
 *  flow) is intentionally preserved — scrubbing it would wipe their OAuth tokens.
 *
 *  When `personaName` names a real persona, the base is the persona config home
 *  (so settings/plugins/projects anchor on the persona, not the global agent),
 *  making the 1on1 nest INSIDE the persona boundary. Default persona → global
 *  agent home, path oauth/<userId> — byte-identical to pre-persona behavior. */
export function ensureInitiatorConfigDir(userId: string, personaName?: string): string {
  const persona = personaName && personaName !== "default" ? personaName : null;
  const base = persona ? ensurePersonaConfigDir(persona) : agentConfigDir();
  const dir = initiatorConfigDir(userId, persona ?? undefined);
  prepareConfigHome(dir, base);
  return dir;
}

/**
 * Make `dir` a usable CLAUDE_CONFIG_DIR that shares everything with `base`
 * except its credentials: settings copied once, plugins linked read-only, and
 * projects/ linked to base's transcript tree. Shared by per-initiator homes and
 * a node's pod-local session homes.
 *
 * projects/ is a symlink because the CLI keys transcripts off CLAUDE_CONFIG_DIR:
 * without it a /1on1 lock (or unlock), or a session landing on another node,
 * would flip the config dir and `resume` would search the wrong home — cold
 * start at lock, stale pre-lock context at unlock. Isolation is for credential
 * stores only; within a persona, transcripts stay in its one tree. Created even
 * when base has no projects/ yet, so the CLI never writes transcripts into dir.
 * A pre-existing real projects/ dir is left as-is (a legacy home with
 * transcripts inside — replacing it would orphan them). A symlink pointing at
 * the wrong target is re-created.
 */
export function prepareConfigHome(dir: string, base: string, mode?: number): void {
  mkdirSync(dir, { recursive: true });
  // mkdir's mode applies only on creation and is masked by umask; set it
  // explicitly so an existing directory is tightened too.
  if (mode !== undefined) chmodSync(dir, mode);
  seedConfigDir(dir, base);

  const srcProjects = join(base, "projects");
  const dstProjects = join(dir, "projects");
  let needsLink = false;
  if (!existsSync(dstProjects)) {
    // existsSync follows links: a dangling link reads as absent. Clear it first.
    try { if (lstatSync(dstProjects).isSymbolicLink()) unlinkSync(dstProjects); } catch { /* absent */ }
    needsLink = true;
  } else {
    try {
      const st = lstatSync(dstProjects);
      if (st.isSymbolicLink() && readlinkSync(dstProjects) !== srcProjects) {
        unlinkSync(dstProjects);
        needsLink = true;
      }
    } catch { /* leave as-is */ }
  }
  if (needsLink) {
    try {
      mkdirSync(srcProjects, { recursive: true });
      symlinkSync(srcProjects, dstProjects, "dir");
    } catch { /* best-effort */ }
  }
}

let warnedMacKeychain = false;

/** CLAUDE_CONFIG_DIR override for a session given its /1on1 lock state and persona.
 *  Locked → the initiator's isolated home (their OAuth identity), nested under the
 *  persona when named. Unlocked + named persona → the persona config home. Unlocked
 *  + default persona → undefined (caller inherits the agent's config dir).
 *
 *  macOS caveat: claude-code stores OAuth creds in the global login Keychain,
 *  which CLAUDE_CONFIG_DIR does NOT isolate — so on darwin a locked session still
 *  inherits the agent's tokens (the isolation is a no-op for OAuth servers). It
 *  works on Linux (file-based `.credentials.json` under CLAUDE_CONFIG_DIR). We
 *  still return the dir (filesystem isolation is harmless) but warn once so a
 *  local macOS run doesn't read as a silent failure. */
export function resolveSessionConfigDir(
  lockedUser: string | null | undefined,
  personaName?: string,
): string | undefined {
  const persona = personaName && personaName !== "default" ? personaName : null;
  if (lockedUser) {
    if (process.platform === "darwin" && !warnedMacKeychain) {
      warnedMacKeychain = true;
      console.warn(
        "[1on1] CLAUDE_CONFIG_DIR isolation is a no-op for OAuth MCP servers on macOS " +
          "(creds live in the global Keychain). Verify on Linux; the deploy target isolates correctly.",
      );
    }
    return ensureInitiatorConfigDir(lockedUser, persona ?? undefined);
  }
  return persona ? ensurePersonaConfigDir(persona) : undefined;
}
