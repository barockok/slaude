import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/home";
import { cliPluginName } from "../soul/builtin";
import { globalSkillsRoot, personaSkillsRoot } from "./loader";

/**
 * The plugin the Skill tool loads home skills from.
 *
 * The agent SDK discovers skills through plugins, and the `$SLAUDE_HOME` plugin
 * exposes only `$SLAUDE_HOME/skills/`. A named persona's own skills
 * (`personas/<name>/skills/`, where `write_skill` puts them) were therefore
 * listed by `list_skills` and readable on disk but not loadable by the Skill
 * tool ("Unknown skill"). A persona's overlay also shadows a shared skill of
 * the same name, which the SDK cannot express with two plugins.
 *
 * For a persona with overlay skills this builds one derived plugin, a
 * directory of symlinks, in place of the home plugin: the shared skills with
 * the overlay's on top. Its manifest carries the home plugin's name, so skill
 * names, the Skill gate, the allow list and usage tracking are unchanged. The
 * directory is named by a hash of what it links to, so concurrent sessions
 * share one and a change produces a new one; stale ones are removed.
 */
const MAX_AGE_MS = 24 * 3600 * 1000;
/** Home plugin parts, besides skills, that a derived plugin passes through. */
const PASSTHROUGH = ["commands", "agents", "hooks"];

const skillDirs = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    const dir = join(root, entry);
    try {
      if (statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))) out.set(entry, dir);
    } catch {
      // unreadable entry: not a skill
    }
  }
  return out;
};

/** Where derived plugins live: beside nothing the node needs to own, and writable by whoever runs the session. */
const baseDir = (): string => join(process.env.SLAUDE_PLUGIN_TMP || tmpdir(), `slaude-home-plugins-${process.getuid?.() ?? "u"}`);

/**
 * The directory to mount as the home plugin for `personaName`: a derived one
 * when the persona has overlay skills, else `null` (mount `$SLAUDE_HOME` as before).
 */
export function homePluginDirFor(personaName: string | undefined): string | null {
  if (!personaName || personaName === "default") return null;
  const overlay = skillDirs(personaSkillsRoot(personaName));
  if (overlay.size === 0) return null;
  const merged = skillDirs(globalSkillsRoot());
  for (const [slug, dir] of overlay) merged.set(slug, dir); // the overlay shadows a shared skill

  const links = [...merged].sort(([a], [b]) => (a < b ? -1 : 1));
  const key = createHash("sha256").update(JSON.stringify([paths.home, links])).digest("hex").slice(0, 16);
  const base = baseDir();
  const dir = join(base, key);
  if (existsSync(join(dir, ".complete"))) {
    try {
      const now = new Date();
      utimesSync(dir, now, now); // in use: keeps it out of prune
    } catch {
      // best effort
    }
    return dir;
  }

  const tmp = `${dir}.build-${process.pid}-${Date.now().toString(36)}`;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    mkdirSync(join(tmp, "skills"), { recursive: true });
    mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
    writeFileSync(join(tmp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: cliPluginName(paths.home), version: "0.0.0" }));
    for (const [slug, target] of links) symlinkSync(target, join(tmp, "skills", slug));
    for (const part of PASSTHROUGH) if (existsSync(join(paths.home, part))) symlinkSync(join(paths.home, part), join(tmp, part));
    writeFileSync(join(tmp, ".complete"), "");
    try {
      renameSync(tmp, dir);
    } catch {
      // another session built the same plugin first: use theirs
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(join(dir, ".complete"))) throw new Error(`could not build ${dir}`);
    }
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // nothing to clean up, or no way to
    }
    console.error(`[skills] could not build the persona skills plugin for ${personaName}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  prune(base, dir);
  return dir;
};

/** Remove derived plugins nobody has asked for in a day (the current one is never touched). */
function prune(base: string, keep: string): void {
  try {
    for (const e of readdirSync(base)) {
      const p = join(base, e);
      if (p === keep || e.includes(".build-")) continue;
      if (Date.now() - statSync(p).mtimeMs > MAX_AGE_MS) rmSync(p, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}
