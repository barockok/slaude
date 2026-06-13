import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { SessionRow } from "../db/schema";
import type { SoulData } from "../soul/data";

export type JailMode = "off" | "discipline" | "adversarial";

/** Slack DM channels are `D`-prefixed; channels `C`, group/mpim `G`. */
export function isDmChannel(channelId: string | null | undefined): boolean {
  return !!channelId && channelId.startsWith("D");
}

/** Unjailed iff a DM whose partner is the primary or backup manager. */
export function isTrustedSession(row: SessionRow, soul: SoulData): boolean {
  if (!isDmChannel(row.slack_channel_id)) return false;
  const id = row.dm_user_id;
  if (!id) return false;
  return id === soul.manager?.userId || id === soul.backupManager?.userId;
}

/** Resolve symlinks on the nearest existing ancestor, then confirm `target`
 *  stays within `root`. Handles not-yet-existing files (new writes). */
export function pathWithinWorkspace(target: string, root: string): boolean {
  const absRoot = realSafe(resolve(root));
  let abs = resolve(absRoot, target);
  // Walk up to the nearest existing ancestor and realpath it (defeats symlink escape).
  let probe = abs;
  while (true) {
    try {
      const real = realpathSync(probe);
      abs = probe === abs ? real : resolve(real, relative(probe, abs));
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break; // reached filesystem root
      probe = parent;
    }
  }
  const rel = relative(absRoot, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const FILE_PATH_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);
const OPTIONAL_PATH_TOOLS = new Set(["Grep", "Glob"]);

/** Extract candidate filesystem paths an SDK tool call would touch. */
export function toolTargetPaths(toolName: string, input: any): string[] {
  if (FILE_PATH_TOOLS.has(toolName) && typeof input?.file_path === "string") {
    return [input.file_path];
  }
  if (OPTIONAL_PATH_TOOLS.has(toolName) && typeof input?.path === "string") {
    return [input.path];
  }
  return [];
}

/** Best-effort (leaky) bash escape detector for `discipline` mode. Flags
 *  absolute paths and `..` traversal that point outside the workspace. */
export function bashEscapesWorkspace(command: string, root: string): boolean {
  if (typeof command !== "string") return false;
  // Absolute path tokens that resolve outside the workspace.
  for (const m of command.matchAll(/(?<![\w/])(\/[^\s;|&()'"<>]+)/g)) {
    if (m[1] && !pathWithinWorkspace(m[1], root)) return true;
  }
  // `..` traversal tokens.
  for (const m of command.matchAll(/(?<![\w/])((?:\.\.\/)+[^\s;|&()'"<>]*)/g)) {
    if (m[1] && !pathWithinWorkspace(m[1], root)) return true;
  }
  return false;
}

export interface JailDecisionArgs {
  mode: JailMode;
  jailed: boolean;
  toolName: string;
  input: any;
  root: string;
}

/** Returns a hard deny result, or null to fall through to the normal gate. */
export function jailDecision(
  args: JailDecisionArgs,
): { behavior: "deny"; message: string } | null {
  const { mode, jailed, toolName, input, root } = args;
  if (!jailed || mode === "off") return null;

  for (const p of toolTargetPaths(toolName, input)) {
    if (!pathWithinWorkspace(p, root)) {
      return { behavior: "deny", message: `workspace jail: \`${p}\` is outside this session's workspace` };
    }
  }
  // OS sandbox owns bash in adversarial mode; only string-check in discipline.
  if (mode === "discipline" && toolName === "Bash" && bashEscapesWorkspace(input?.command, root)) {
    return { behavior: "deny", message: "workspace jail: command reaches outside this session's workspace" };
  }
  return null;
}
