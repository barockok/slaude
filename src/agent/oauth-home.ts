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
import {
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  copyFileSync,
  symlinkSync,
  readdirSync,
  renameSync,
  cpSync,
  rmSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/home";

/** The agent's own claude config dir (where its OAuth tokens + plugins live).
 *  Falls back to `~/.claude` — the CLI's built-in default — so the projects/
 *  symlink in initiator dirs always targets the same location as unlocked sessions. */
export function agentConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** lstat that reports the LINK itself (never its target) and never throws.
 *  null = nothing at this path. */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Idempotently point `link` at `target`. Returns false when the path is
 * occupied by a real file/dir (the caller owns that decision).
 *
 * Deliberately lstat-based, NOT existsSync-based: existsSync follows symlinks,
 * so a link whose target no longer exists (an agent home that moved — e.g. the
 * old `$SLAUDE_HOME/.claude` from before agentConfigDir() was fixed to
 * `~/.claude`) reads as "missing". The old code then took the create branch,
 * symlinkSync threw EEXIST on the link that WAS there, the error was swallowed,
 * and the dangling link survived every subsequent boot. For `projects/` that
 * means a locked thread has nowhere to write its transcript, so every /1on1
 * resume cold-starts with no history — silently, since a resume miss is a
 * suppressed, self-healing condition upstream.
 */
function ensureSymlink(target: string, link: string): boolean {
  const st = lstatOrNull(link);
  if (st?.isSymbolicLink()) {
    let current: string | null = null;
    try {
      current = readlinkSync(link);
    } catch {
      /* unreadable link — replace it */
    }
    if (current === target) return true;
    try {
      unlinkSync(link);
    } catch (e) {
      console.warn(`[1on1] could not unlink stale ${link}:`, (e as Error).message);
      return false;
    }
  } else if (st) {
    return false; // real file/dir — not ours to replace
  }
  try {
    symlinkSync(target, link, "dir");
    return true;
  } catch (e) {
    console.warn(`[1on1] could not link ${link} -> ${target}:`, (e as Error).message);
    return false;
  }
}

/** rename, falling back to copy+remove across devices (SLAUDE_HOME and the
 *  agent config home can sit on different mounts). */
function moveNode(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch {
    /* EXDEV / busy — copy instead */
  }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}

/** Merge `srcDir` into `dstDir` without ever overwriting. Directories present on
 *  both sides are merged recursively; a leaf that already exists in `dstDir`
 *  keeps the dst copy and the src copy is parked under `parked` rather than
 *  dropped. */
function mergeInto(srcDir: string, dstDir: string, parked: string): void {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const from = join(srcDir, name);
    const to = join(dstDir, name);
    const fromSt = lstatOrNull(from);
    const toSt = lstatOrNull(to);
    if (toSt && fromSt?.isDirectory() && toSt.isDirectory()) {
      mergeInto(from, to, join(parked, name));
      continue;
    }
    if (toSt) {
      // Same session id in both homes: the base home is the one unlocked turns
      // read, so it wins — but the legacy copy is parked, never deleted.
      mkdirSync(parked, { recursive: true });
      moveNode(from, join(parked, name));
      continue;
    }
    moveNode(from, to);
  }
}

/** Fold a legacy REAL projects/ dir in an initiator home into the base
 *  transcript home so resume finds those transcripts after a lock flip, then
 *  clear the path for the symlink. Leaves everything in place on failure —
 *  the caller's ensureSymlink then declines and behavior is as before. */
function migrateLegacyProjects(dstProjects: string, srcProjects: string, dir: string): void {
  const parked = join(dir, `projects.legacy-${Date.now()}`);
  try {
    mergeInto(dstProjects, srcProjects, parked);
    rmSync(dstProjects, { recursive: true, force: true });
    console.log(`[1on1] migrated legacy transcripts ${dstProjects} -> ${srcProjects}`);
    if (existsSync(parked)) {
      console.warn(`[1on1] conflicting legacy transcripts parked at ${parked} (base home kept)`);
    }
  } catch (e) {
    console.warn(`[1on1] legacy projects/ migration failed for ${dir}:`, (e as Error).message);
  }
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
  // Repaired on every call for the same reason projects/ is: a link left
  // dangling by a moved agent home would otherwise cost the locked session its
  // skills and plugins for good.
  const srcPlugins = join(src, "plugins");
  if (existsSync(srcPlugins)) ensureSymlink(srcPlugins, join(dir, "plugins"));
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
  mkdirSync(dir, { recursive: true });

  seedConfigDir(dir, base);

  // projects/ — symlink to the base transcript home (persona home for a named
  // persona, else the global agent home). The CLI keys transcripts off
  // CLAUDE_CONFIG_DIR, so without this a /1on1 lock (or unlock) flips the config
  // dir and `resume` searches the wrong home: cold start at lock, stale pre-lock
  // context at unlock. Isolation is for credential stores only — within a persona,
  // its 1on1 transcripts must stay in the persona's one transcript tree. The base
  // projects/ dir is created first so a thread that starts life locked still
  // writes through the link.
  const srcProjects = join(base, "projects");
  const dstProjects = join(dir, "projects");
  try {
    mkdirSync(srcProjects, { recursive: true });
  } catch (e) {
    console.warn(`[1on1] could not create ${srcProjects}:`, (e as Error).message);
  }
  // A REAL projects/ dir here is a legacy initiator home (transcripts written
  // before the link existed). Fold it into the base home instead of leaving it
  // as a permanent shard — an operator who used /1on1 before the fix would
  // otherwise never heal, which reads exactly like the bug being back.
  const dstSt = lstatOrNull(dstProjects);
  if (dstSt && !dstSt.isSymbolicLink()) migrateLegacyProjects(dstProjects, srcProjects, dir);
  ensureSymlink(srcProjects, dstProjects);
  return dir;
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
