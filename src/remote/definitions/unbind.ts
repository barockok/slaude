/**
 * The rollback step for rc.21: a thread bound to a shared environment is read by
 * rc.21 as a personal ssh row (owner = the definition's name), so before
 * redeploying rc.21 every binding to a definition row must go. Definition rows
 * themselves stay (the rc.22 columns are never dropped). Counts and names only.
 */
import { db } from "../../db/schema";

export interface SharedBindingCount {
  name: string;
  tenant: string;
  threads: number;
}

const SHARED = "env_id IN (SELECT id FROM environments WHERE source = 'definition')";

export async function sharedBindingCounts(): Promise<SharedBindingCount[]> {
  const rows = await db.query<{ name: string; tenant_id: string; n: number | string }>(
    `SELECT e.name AS name, ${db.dialect === "pg" ? "e.tenant_id" : "'default'"} AS tenant_id, COUNT(*) AS n
     FROM env_bindings b JOIN environments e ON e.id = b.env_id
     WHERE e.source = 'definition' GROUP BY e.name${db.dialect === "pg" ? ", e.tenant_id" : ""} ORDER BY e.name`,
  );
  return rows.map((r) => ({ name: r.name, tenant: r.tenant_id, threads: Number(r.n) }));
}

/** Delete every binding to a definition row. Returns how many threads were unbound. */
export async function unbindShared(): Promise<number> {
  const r = await db.run(`DELETE FROM env_bindings WHERE ${SHARED}`);
  return r.changes ?? 0;
}
