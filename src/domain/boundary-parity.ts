/**
 * `slaude domain boundary-check` (domain sessions, slice D, rc.23): the read-only
 * recomputation behind the gate for moving the unique indexes. It never writes,
 * never reads `audit_events`, and pages by primary key.
 *
 * Per table it reports:
 *  - `nullOld`: rows whose `boundary_id` is NULL, older than `minAgeMs` (10
 *    minutes), on an eligible channel with a resolvable workspace. This is the
 *    gate number and must be 0. `ineligible` and `unresolvable` rows are listed
 *    apart and excluded from it.
 *  - `mismatch`: rows whose `boundary_id` differs from the boundary resolved from
 *    the row's own team and channel (or names a boundary that does not exist).
 *  - `locatorMismatch`: rows whose `locator` differs from the thread column (the
 *    cron rule for cron jobs).
 *  - `duplicates`: groups sharing `(boundary_id, locator, persona_id)` in
 *    sessions, `(boundary_id, locator)` in the one-conversation-per-key tables.
 *
 * Samples carry masked keys only (the head and tail of an id).
 */
import { cronLocator } from "../db/boundary-columns";
import type { DbClient } from "../db/schema";
import { CHANNEL_RE } from "./boundary-for";
import { SPECS, type Place, type Spec } from "./boundary-backfill";

export const GATE_MIN_AGE_MS = 10 * 60 * 1000;
export const SAMPLE_CAP = 20;
const DEFAULT_TENANT = "default";

/** Column that dates a row, per table (none: cron jobs carry no creation time, so every NULL row counts). */
const AGE_COLUMN: Record<string, string | null> = {
  sessions: "created_at",
  one_on_one_locks: "created_at",
  mention_only_threads: "created_at",
  ignores: "created_at",
  cron_jobs: null,
  commitments: "created_at",
  env_bindings: "created_at",
  proactive_posts: "posted_at",
  channel_wake_state: "updated_at",
};

/** Tables where `(boundary_id, locator[, persona_id])` must name one row. */
const DUPLICATE_KEYS: Record<string, string> = {
  sessions: "boundary_id, locator, persona_id",
  one_on_one_locks: "boundary_id, locator",
  mention_only_threads: "boundary_id, locator",
  env_bindings: "boundary_id, locator",
};

export interface Sample {
  kind: "mismatch" | "locator_mismatch" | "null_old";
  /** Masked primary key. */
  row: string;
}

export interface ParityTableReport {
  table: string;
  filled: number;
  nullOld: number;
  nullYoung: number;
  ineligible: number;
  unresolvable: number;
  /** Filled rows whose workspace cannot be decided (team-less, several workspaces): not checked, not failing. */
  unverifiable: number;
  mismatch: number;
  locatorMismatch: number;
  duplicates: number;
  samples: Sample[];
}

export interface ParityReport {
  tables: ParityTableReport[];
  /** True when every gate number is 0 and no mismatch or duplicate exists. */
  ok: boolean;
  checkedAt: number;
}

/** Head and tail of a value, never the whole. */
export function mask(v: unknown): string {
  const s = String(v ?? "");
  return s.length <= 6 ? "***" : `${s.slice(0, 3)}***${s.slice(-2)}`;
}

export interface ParityOptions {
  place: Place;
  table?: string;
  pageSize?: number;
  now?: () => number;
  minAgeMs?: number;
}

export async function boundaryParity(c: DbClient, o: ParityOptions): Promise<ParityReport> {
  const now = (o.now ?? Date.now)();
  const minAge = o.minAgeMs ?? GATE_MIN_AGE_MS;
  const pageSize = o.pageSize ?? 500;
  const specs = o.table ? SPECS.filter((s) => s.table === o.table) : SPECS;
  if (o.table && specs.length === 0) throw new Error(`unknown table '${o.table}' (one of ${SPECS.map((s) => s.table).join(", ")})`);
  const pg = c.dialect === "pg";
  const tenantTables = new Set<string>();
  if (pg) {
    for (const r of await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND table_name IN (${SPECS.map(() => "?").join(", ")})`,
      SPECS.map((x) => x.table),
    ))
      tenantTables.add(r.table_name);
  }
  const boundaryCache = new Map<string, string | null>();
  const boundaryOf = async (team: string, channel: string): Promise<string | null> => {
    const key = `${team}|${channel}`;
    if (!boundaryCache.has(key)) {
      const r = await c.one<{ id: string }>("SELECT id FROM boundaries WHERE service = 'slack' AND workspace = ? AND value = ?", [team, channel]);
      boundaryCache.set(key, r?.id ?? null);
    }
    return boundaryCache.get(key)!;
  };

  const tables: ParityTableReport[] = [];
  for (const spec of specs) {
    const rep: ParityTableReport = { table: spec.table, filled: 0, nullOld: 0, nullYoung: 0, ineligible: 0, unresolvable: 0, unverifiable: 0, mismatch: 0, locatorMismatch: 0, duplicates: 0, samples: [] };
    const sample = (kind: Sample["kind"], pk: unknown[]) => {
      if (rep.samples.length < SAMPLE_CAP) rep.samples.push({ kind, row: pk.map(mask).join(":") });
    };
    await scan(c, spec, tenantTables, pageSize, AGE_COLUMN[spec.table] ?? null, async (r) => {
      const eligible = !!r.channel && CHANNEL_RE.test(r.channel);
      let team = r.team;
      if (!team && eligible) {
        const p = o.place(r.tenant);
        team = "ws" in p ? p.ws : null;
      }
      if (r.boundary === null) {
        if (!eligible) return void rep.ineligible++;
        if (!team) return void rep.unresolvable++;
        if (r.created !== null && now - r.created < minAge) return void rep.nullYoung++;
        rep.nullOld++;
        sample("null_old", r.pk);
        return;
      }
      rep.filled++;
      if (!eligible) {
        // A boundary on a channel first sight never records cannot be right.
        rep.mismatch++;
        sample("mismatch", r.pk);
      } else if (!team) {
        rep.unverifiable++;
      } else {
        const want = await boundaryOf(team, r.channel!);
        if (want !== r.boundary) {
          rep.mismatch++;
          sample("mismatch", r.pk);
        }
      }
      if (spec.thread) {
        const want = spec.table === "cron_jobs" ? cronLocator({ id: String(r.pk[0]), target: r.target, slackThreadTs: r.thread }) : r.thread;
        if ((r.locator ?? null) !== (want || null)) {
          rep.locatorMismatch++;
          sample("locator_mismatch", r.pk);
        }
      }
    });
    const key = DUPLICATE_KEYS[spec.table];
    if (key) {
      const d = await c.one<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${spec.table} WHERE boundary_id IS NOT NULL GROUP BY ${key} HAVING COUNT(*) > 1) g`,
      );
      rep.duplicates = Number(d?.n ?? 0);
    }
    tables.push(rep);
  }
  const ok = tables.every((t) => t.nullOld === 0 && t.mismatch === 0 && t.locatorMismatch === 0 && t.duplicates === 0);
  return { tables, ok, checkedAt: now };
}

interface ScanRow {
  tenant: string;
  team: string | null;
  channel: string | null;
  thread: string | null;
  target: string | null;
  boundary: string | null;
  locator: string | null;
  created: number | null;
  pk: unknown[];
}

/** Every row of a table (read only), in primary key pages. */
async function scan(c: DbClient, spec: Spec, tenantTables: Set<string>, pageSize: number, ageCol: string | null, each: (r: ScanRow) => Promise<void>): Promise<void> {
  const T = tenantTables.has(spec.table) ? "tenant_id" : `'${DEFAULT_TENANT}'`;
  const hasLocator = spec.thread !== null;
  const cols = [
    `${T} AS tenant`,
    spec.team ? `${spec.team} AS team` : "NULL AS team",
    `${spec.channel} AS channel`,
    spec.thread ? `${spec.thread} AS thread` : "NULL AS thread",
    spec.extra?.includes("target") ? "target AS target" : "NULL AS target",
    "boundary_id AS boundary",
    hasLocator ? "locator AS locator" : "NULL AS locator",
    ageCol ? `${ageCol} AS created` : "NULL AS created",
    ...spec.pk.map((k, i) => `${k} AS pk${i}`),
  ].join(", ");
  const tuple = spec.pk.length > 1 ? `(${spec.pk.join(", ")})` : spec.pk[0]!;
  const marks = spec.pk.length > 1 ? `(${spec.pk.map(() => "?").join(", ")})` : "?";
  let after: unknown[] | null = null;
  for (;;) {
    const page: Array<Record<string, unknown>> = await c.query(
      `SELECT ${cols} FROM ${spec.table} WHERE ${spec.where ?? "1 = 1"} ${after ? `AND ${tuple} > ${marks}` : ""} ORDER BY ${spec.pk.join(", ")} LIMIT ?`,
      [...(after ?? []), pageSize],
    );
    if (page.length === 0) return;
    after = spec.pk.map((_, i) => page[page.length - 1]![`pk${i}`]);
    for (const raw of page) {
      await each({
        tenant: String(raw.tenant),
        team: (raw.team as string | null) || null,
        channel: (raw.channel as string | null) || null,
        thread: (raw.thread as string | null) || null,
        target: (raw.target as string | null) || null,
        boundary: (raw.boundary as string | null) || null,
        locator: (raw.locator as string | null) || null,
        created: raw.created === null || raw.created === undefined ? null : Number(raw.created),
        pk: spec.pk.map((_, i) => raw[`pk${i}`]),
      });
    }
    if (page.length < pageSize) return;
  }
}

export function formatParity(r: ParityReport): string {
  const lines = [`boundary check: ${r.ok ? "OK, the gate numbers are 0" : "NOT CLEAN"}`];
  for (const t of r.tables) {
    const left = [`ineligible ${t.ineligible}`, `unresolvable ${t.unresolvable}`, `young NULL ${t.nullYoung}`, `unverifiable ${t.unverifiable}`].join(", ");
    lines.push(
      `  ${t.table.padEnd(22)} filled ${t.filled}, NULL older than 10 min ${t.nullOld}, mismatch ${t.mismatch}, locator mismatch ${t.locatorMismatch}, duplicate groups ${t.duplicates} (${left})`,
    );
    for (const s of t.samples) lines.push(`    ${s.kind} ${s.row}`);
  }
  return lines.join("\n");
}
