import { db } from "./schema";
import type { PluginReport } from "../config/plugin-inventory";

/** One node process's plugin report (migration 0035). */
export interface NodePluginsRow {
  /** The verified credential's id. */
  nodeId: string;
  /** The process id it heartbeats under. */
  instance: string;
  labels: string[];
  reportedAt: number;
  /** Epoch ms this process was last seen live; starts at the report. */
  lastSeenAt: number;
  /** Unix seconds the reporting credential was issued (0 for the legacy token). */
  credentialIat: number;
  report: PluginReport;
}

/** A bound on one credential's rows (and so on what a stolen one can store). */
export const MAX_ROWS_PER_CREDENTIAL = 256;

interface Row {
  node_id: string;
  instance_id: string;
  labels: string;
  reported_at: number | string;
  last_seen_at: number | string;
  credential_iat: number | string;
  report: string;
}

const parseRow = (r: Row): NodePluginsRow | null => {
  try {
    return {
      nodeId: r.node_id,
      instance: r.instance_id,
      labels: JSON.parse(r.labels) as string[],
      reportedAt: Number(r.reported_at),
      lastSeenAt: Number(r.last_seen_at),
      credentialIat: Number(r.credential_iat),
      report: JSON.parse(r.report) as PluginReport,
    };
  } catch {
    return null;
  }
};

/** Store a process's report. "duplicate" when one exists for that process: the
 *  first report wins, so a stolen credential cannot rewrite a live process's
 *  report. "cap" when the credential holds its maximum of rows. The cap is read
 *  before the insert, so concurrent reports can pass it by a few rows. */
export async function insertNodePlugins(row: NodePluginsRow): Promise<"stored" | "duplicate" | "cap"> {
  const held = await db.one<{ n: number | string }>(`SELECT COUNT(*) AS n FROM node_plugins WHERE node_id = ?`, [row.nodeId]);
  if (Number(held?.n ?? 0) >= MAX_ROWS_PER_CREDENTIAL) return "cap";
  const r = await db.run(
    `INSERT INTO node_plugins (node_id, instance_id, labels, reported_at, last_seen_at, credential_iat, report) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [row.nodeId, row.instance, JSON.stringify(row.labels), row.reportedAt, row.lastSeenAt, row.credentialIat, JSON.stringify(row.report)],
  );
  return r.changes > 0 ? "stored" : "duplicate";
}

export async function listNodePlugins(): Promise<NodePluginsRow[]> {
  const rows = await db.query<Row>(`SELECT node_id, instance_id, labels, reported_at, last_seen_at, credential_iat, report FROM node_plugins ORDER BY node_id, instance_id`);
  return rows.flatMap((r) => parseRow(r) ?? []);
}

/** Record that these processes were seen live. */
export async function touchNodePluginInstances(instances: readonly string[], at: number): Promise<void> {
  for (const id of instances) await db.run(`UPDATE node_plugins SET last_seen_at = ? WHERE instance_id = ?`, [at, id]);
}

/** Remove the given process rows. */
export async function deleteNodePluginInstances(instances: readonly string[]): Promise<void> {
  for (const id of instances) await db.run(`DELETE FROM node_plugins WHERE instance_id = ?`, [id]);
}
