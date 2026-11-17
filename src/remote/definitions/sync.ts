/**
 * Definition sync: the `environments` list of a /deploy payload, written in the
 * same transaction as the personas. The list is the deploy repo's whole set: a
 * stored definition it no longer lists is retired (never deleted), a retired
 * one it lists again is revived. A resync with the same canonical hash writes
 * nothing and moves no `updated_at`, so no warm session reboots.
 *
 * The key pair of a new definition is generated and stored inside the sync
 * transaction (`putKeyIfAbsentTx`), so a failed sync leaves no orphan key.
 * Reports and audit carry names only: never a host, an address or a key.
 */
import type { DbClient } from "../../db/client";
import type { EnvRowShape } from "../../db/environments";
import { putKeyIfAbsentTx, type RemoteKeyPair } from "../../db/remote";
import { generateSshKeyPair } from "../keygen";
import type { ParsedEnvironmentDefinition } from "./parse";
import { definitionRows, definitionRowId, definitionTeam } from "./resolve";

export interface EnvironmentsReport {
  created: string[];
  updated: string[];
  revived: string[];
  unchanged: string[];
  retired: string[];
  /** Revived definitions that threads are still bound to, with how many: those threads use the machine again at once. Only when any. */
  revivedBound?: Record<string, number>;
}

export const emptyEnvironmentsReport = (): EnvironmentsReport => ({ created: [], updated: [], revived: [], unchanged: [], retired: [] });

export interface DefinitionPlan {
  report: EnvironmentsReport;
  create: ParsedEnvironmentDefinition[];
  update: Array<{ def: ParsedEnvironmentDefinition; row: EnvRowShape; revive: boolean }>;
  retire: EnvRowShape[];
}

/** What a sync of this set would do. Reads only. */
export async function planDefinitions(c: Pick<DbClient, "query" | "one">, tenant: string, defs: ParsedEnvironmentDefinition[]): Promise<DefinitionPlan> {
  const rows = new Map((await definitionRows(c, tenant)).map((r) => [r.definition_name!, r]));
  const plan: DefinitionPlan = { report: emptyEnvironmentsReport(), create: [], update: [], retire: [] };
  const listed = new Set<string>();
  for (const def of defs) {
    listed.add(def.name);
    const row = rows.get(def.name);
    if (!row) {
      plan.create.push(def);
      plan.report.created.push(def.name);
    } else if (row.retired_at != null) {
      plan.update.push({ def, row, revive: true });
      plan.report.revived.push(def.name);
      // Bindings kept while it was retired come back to life with it: say so.
      const bound = Number((await c.one<{ n: number | string }>("SELECT COUNT(*) AS n FROM env_bindings WHERE env_id = ?", [row.id]))?.n ?? 0);
      if (bound > 0) (plan.report.revivedBound ??= {})[def.name] = bound;
    } else if (row.definition_hash !== def.hash) {
      plan.update.push({ def, row, revive: false });
      plan.report.updated.push(def.name);
    } else {
      plan.report.unchanged.push(def.name);
    }
  }
  for (const [name, row] of rows) {
    if (listed.has(name) || row.retired_at != null) continue;
    plan.retire.push(row);
    plan.report.retired.push(name);
  }
  return plan;
}

export const changed = (r: EnvironmentsReport): boolean => r.created.length + r.updated.length + r.revived.length + r.retired.length > 0;

/** Plan and write, inside the caller's transaction. `generateKey` is a test seam. */
export async function applyDefinitions(
  tx: DbClient,
  tenant: string,
  defs: ParsedEnvironmentDefinition[],
  meta: { revision: string },
  generateKey: (name: string) => RemoteKeyPair = (name) => generateSshKeyPair(`slaude:env:${name}`),
): Promise<EnvironmentsReport> {
  const plan = await planDefinitions(tx, tenant, defs);
  const now = Date.now();
  const team = definitionTeam(tenant);
  for (const def of plan.create) {
    await tx.run(
      `INSERT INTO environments (id, tenant_id, team_id, user_id, name, kind, config, secrets, default_dir, created_at, updated_at,
                                 source, definition_name, definition_hash, definition_revision, description, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'definition', ?, ?, ?, ?, NULL)`,
      [definitionRowId(tenant, def.name), tenant, team, def.name, def.name, def.kind, JSON.stringify(def.config), def.defaultDir, now, now,
       def.name, def.hash, meta.revision, def.description],
    );
    await putKeyIfAbsentTx(tx, team, def.name, generateKey(def.name));
  }
  for (const { def, row } of plan.update) {
    await tx.run(
      `UPDATE environments SET kind = ?, config = ?, default_dir = ?, description = ?, definition_hash = ?, definition_revision = ?,
                               retired_at = NULL, updated_at = ?
       WHERE id = ?`,
      [def.kind, JSON.stringify(def.config), def.defaultDir, def.description, def.hash, meta.revision, Math.max(now, Number(row.updated_at) + 1), row.id],
    );
    // A definition whose key went missing gets a fresh one; an existing key is never replaced (and needs no master key to leave alone).
    const haveKey = await tx.one("SELECT 1 AS x FROM remote_keys WHERE team_id = ? AND user_id = ?", [team, def.name]);
    if (!haveKey) await putKeyIfAbsentTx(tx, team, def.name, generateKey(def.name));
  }
  for (const row of plan.retire) {
    await tx.run(`UPDATE environments SET retired_at = ?, definition_revision = ?, updated_at = ? WHERE id = ?`,
      [now, meta.revision, Math.max(now, Number(row.updated_at) + 1), row.id]);
  }
  return plan.report;
}
