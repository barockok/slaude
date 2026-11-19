/**
 * Names that never sync. A path is ignored when any of its segments equals an
 * entry. With no size limit on a workspace this list is the only brake on a
 * runaway tree, so the default is conservative; `SLAUDE_SYNC_IGNORE` replaces it
 * (comma-separated names, not globs).
 */
export const DEFAULT_IGNORE = ["node_modules", ".cache", "__pycache__", ".venv"];

/** Always ignored, whatever the list says: the sync's own bookkeeping. */
const ALWAYS = /^\.slaude-sync(\.|$)/;

export function ignoreList(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.SLAUDE_SYNC_IGNORE;
  if (raw === undefined) return DEFAULT_IGNORE;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isIgnored(relPath: string, names: readonly string[]): boolean {
  for (const seg of relPath.split("/")) {
    if (ALWAYS.test(seg) || names.includes(seg)) return true;
  }
  return false;
}
