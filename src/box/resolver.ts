/**
 * What a session's sandbox is given (box spec, "Architecture"): the mounts of
 * its BoxSpec. The node worker supplies the session's own paths; this module
 * decides what of them a box may see.
 *
 *   /home/agent           the session's home (durable through the `hm` unit)
 *   <working directory>   read-write, at its node path
 *   <config directory>    the session's CLAUDE_CONFIG_DIR, read-write, at its
 *                         node path, and what its links lead to:
 *                           projects/  only THIS working directory's
 *                                      transcript folder, read-write;
 *                           others     read-only (the shared plugin cache);
 *   <scratch directory>   read-write, at its node path
 *   plugin directories    read-only, at their node paths
 *   the CLI               its directory, read-only, at its node path
 *
 * Paths are identical inside and outside wherever the node also reads them
 * (the transcript, the upload guard, hooks that name a file), so nothing has
 * to translate one.
 *
 * Two things are deliberately NOT mounted:
 *   - the slaude home itself. It is a plugin directory for the SDK (its
 *     `skills/`), but it also holds every other session's workspace. A box
 *     gets its plugin parts only;
 *   - the base config home's `projects/` as a whole: it holds other sessions'
 *     transcripts.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { encodeProjectDir } from "../storage/units";
import { BOX_HOME } from "./env";
import type { BoxPolicy } from "./policy";
import type { BoxMount, BoxSpec } from "./sandbox";

/** The parts of a plugin directory the SDK reads. Used for the slaude home, which is mounted by part. */
const PLUGIN_PARTS: readonly string[] = [".claude-plugin", "skills", "commands", "agents", "hooks"];

/** A session id as the one path segment its box directory is named by. The same rule as the node's home directory (src/node/box-node.ts). */
export function boxSessionSegment(sessionId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId) && !sessionId.includes("..") ? sessionId : Buffer.from(sessionId).toString("hex").slice(0, 64);
}

export interface BoxSpecInput {
  sessionId: string;
  tenantId: string;
  persona: string;
  box: { digest: string; policy: BoxPolicy };
  /** The session's home on this node. */
  homeDir: string;
  /** The session's working directory. */
  cwd: string;
  /** The session's CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** The session's scratch directory, when it has one. */
  scratchDir?: string;
  /** Plugin directories the SDK is given for this session. */
  pluginDirs: readonly string[];
  /** The slaude home: mounted by part when it is one of the plugin directories. */
  slaudeHome: string;
  /** The directory that holds the CLI binary the SDK spawns. */
  cliDir: string;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Where a symlink points, as an absolute path. */
function linkTarget(link: string): string {
  const t = readlinkSync(link);
  return isAbsolute(t) ? t : resolve(dirname(link), t);
}

/** The mounts of a session's sandbox. Sources that do not exist are left out (a plugin directory that was never created). */
export function boxMounts(i: BoxSpecInput): BoxMount[] {
  const mounts: BoxMount[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, mode: "ro" | "rw"): void => {
    // The first mount of a target wins: read-write ones are added first.
    if (seen.has(target) || !existsSync(source)) return;
    seen.add(target);
    mounts.push({ source, target, mode });
  };
  const same = (p: string, mode: "ro" | "rw") => add(p, p, mode);

  const cwd = real(i.cwd);
  add(i.homeDir, BOX_HOME, "rw");
  same(i.cwd, "rw");
  if (cwd !== i.cwd) same(cwd, "rw");
  same(i.configDir, "rw");
  if (i.scratchDir) same(i.scratchDir, "rw");

  // What the config directory's links lead to.
  let names: string[] = [];
  try {
    names = readdirSync(i.configDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const link = join(i.configDir, name);
    if (!isLink(link)) continue;
    const target = linkTarget(link);
    if (name === "projects") {
      // One folder of the persona's transcript tree: this working directory's. The CLI finds it through the link.
      const mine = join(target, encodeProjectDir(cwd));
      mkdirSync(mine, { recursive: true });
      same(mine, "rw");
    } else {
      same(target, "ro");
    }
  }

  const home = real(i.slaudeHome);
  for (const dir of i.pluginDirs) {
    if (!existsSync(dir)) continue;
    if (real(dir) === home) {
      for (const part of PLUGIN_PARTS) same(join(dir, part), "ro");
      continue;
    }
    same(dir, "ro");
    // A derived plugin directory links to the skills it gathers: what those links name is mounted too.
    for (const sub of [dir, join(dir, "skills")]) {
      let entries: string[] = [];
      try {
        entries = readdirSync(sub);
      } catch {
        entries = [];
      }
      for (const e of entries) if (isLink(join(sub, e))) same(linkTarget(join(sub, e)), "ro");
    }
  }

  same(i.cliDir, "ro");
  return mounts;
}

/** A session's BoxSpec. `configDir` and `scratchDir` ride along for the driver, which builds the box's environment from them. */
export function buildBoxSpec(i: BoxSpecInput): BoxSpec {
  return {
    sessionId: i.sessionId,
    tenantId: i.tenantId,
    persona: i.persona,
    digest: i.box.digest,
    policy: i.box.policy,
    mounts: boxMounts(i),
    cwd: i.cwd,
    configDir: i.configDir,
    ...(i.scratchDir ? { scratchDir: i.scratchDir } : {}),
  };
}
