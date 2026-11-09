import { db } from "./schema";

/**
 * Version log of the skills on disk (migration 0034). Files stay the runtime
 * authority: rows are written by src/skills/versions.ts in the gateway or mono
 * process and read by the console. Rows are never updated, and are deleted only
 * when the persona that owns them is removed.
 */
export const GLOBAL_SCOPE = "global";

/** The version-log scope of a persona's own root (undefined or `default`: the shared base). */
export function versionScope(personaName?: string | null): string {
  if (!personaName || personaName === "default") return GLOBAL_SCOPE;
  return personaName === GLOBAL_SCOPE ? `persona:${personaName}` : personaName;
}

/** The persona a persona scope belongs to (inverse of versionScope). */
export const personaOfScope = (scope: string): string => scope.replace(/^persona:/, "");

export type SkillVersionOrigin = "bundled" | "installed" | "agent";

export interface SkillVersionMeta {
  scope: string;
  slug: string;
  version: number;
  contentHash: string;
  skillMdTruncated: boolean;
  fileCount: number;
  totalBytes: number;
  capturedAt: number;
  origin: SkillVersionOrigin;
}

export interface SkillVersion extends SkillVersionMeta {
  skillMd: string;
}

interface MetaRow {
  scope: string;
  slug: string;
  version: number | string;
  content_hash: string;
  skill_md_truncated: number | string;
  file_count: number | string;
  total_bytes: number | string;
  captured_at: number | string;
  origin: string;
}

const META_COLUMNS = "scope, slug, version, content_hash, skill_md_truncated, file_count, total_bytes, captured_at, origin";

const toMeta = (r: MetaRow): SkillVersionMeta => ({
  scope: r.scope,
  slug: r.slug,
  version: Number(r.version),
  contentHash: r.content_hash,
  skillMdTruncated: Number(r.skill_md_truncated) !== 0,
  fileCount: Number(r.file_count),
  totalBytes: Number(r.total_bytes),
  capturedAt: Number(r.captured_at),
  origin: r.origin as SkillVersionOrigin,
});

/** The newest row of a skill, or null before its first capture. */
export async function latest(scope: string, slug: string): Promise<SkillVersionMeta | null> {
  const row = await db.one<MetaRow>(
    `SELECT ${META_COLUMNS} FROM skill_versions WHERE scope = ? AND slug = ? ORDER BY version DESC LIMIT 1`,
    [scope, slug],
  );
  return row ? toMeta(row) : null;
}

/**
 * Insert one row. False when another replica already holds that version of the
 * skill: the caller re-reads the latest row and decides again.
 */
export async function insert(v: SkillVersion): Promise<boolean> {
  const r = await db.run(
    `INSERT INTO skill_versions
       (scope, slug, version, content_hash, skill_md, skill_md_truncated, file_count, total_bytes, captured_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, slug, version) DO NOTHING`,
    [v.scope, v.slug, v.version, v.contentHash, v.skillMd, v.skillMdTruncated ? 1 : 0, v.fileCount, v.totalBytes, v.capturedAt, v.origin],
  );
  return r.changes > 0;
}

/** A skill's rows, newest first, without the text; with `upTo`, only rows captured by then. */
export async function list(scope: string, slug: string, limit: number, upTo?: number): Promise<SkillVersionMeta[]> {
  const rows = await db.query<MetaRow>(
    `SELECT ${META_COLUMNS} FROM skill_versions
      WHERE scope = ? AND slug = ? ${upTo === undefined ? "" : "AND captured_at <= ?"}
      ORDER BY version DESC LIMIT ?`,
    upTo === undefined ? [scope, slug, limit] : [scope, slug, upTo, limit],
  );
  return rows.map(toMeta);
}

/** One row with its text, or null. */
export async function get(scope: string, slug: string, version: number): Promise<SkillVersion | null> {
  const row = await db.one<MetaRow & { skill_md: string }>(
    `SELECT ${META_COLUMNS}, skill_md FROM skill_versions WHERE scope = ? AND slug = ? AND version = ?`,
    [scope, slug, version],
  );
  return row ? { ...toMeta(row), skillMd: row.skill_md } : null;
}

/** The current version number per skill, keyed by versionKey(scope, slug). */
export async function currentVersions(): Promise<Map<string, number>> {
  const rows = await db.query<{ scope: string; slug: string; version: number | string }>(
    "SELECT scope, slug, MAX(version) AS version FROM skill_versions GROUP BY scope, slug",
  );
  return new Map(rows.map((r) => [versionKey(r.scope, r.slug), Number(r.version)]));
}

export const versionKey = (scope: string, slug: string): string => `${scope}\u0000${slug}`;

/** Every persona scope with rows. */
export async function personaScopes(): Promise<string[]> {
  const rows = await db.query<{ scope: string }>("SELECT DISTINCT scope FROM skill_versions WHERE scope <> ?", [GLOBAL_SCOPE]);
  return rows.map((r) => r.scope);
}

/** Delete a removed persona's rows, so a later persona of that name cannot read them. Never the shared base's. */
export async function deleteForPersona(personaName: string): Promise<number> {
  const scope = versionScope(personaName);
  if (scope === GLOBAL_SCOPE) return 0;
  return (await db.run("DELETE FROM skill_versions WHERE scope = ?", [scope])).changes;
}
