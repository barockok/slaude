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
  report: PluginReport;
}

interface Row {
  node_id: string;
  instance_id: string;
  labels: string;
  reported_at: number | string;
  report: string;
}

const parseRow = (r: Row): NodePluginsRow | null => {
  try {
    return {
      nodeId: r.node_id,
      instance: r.instance_id,
      labels: JSON.parse(r.labels) as string[],
      reportedAt: Number(r.reported_at),
      report: JSON.parse(r.report) as PluginReport,
    };
  } catch {
    return null;
  }
};

/** Store a process's report. False when one exists for that process: the first
 *  report wins, so a stolen credential cannot rewrite a live process's report. */
export async function insertNodePlugins(row: NodePluginsRow): Promise<boolean> {
  const r = await db.run(
    `INSERT INTO node_plugins (node_id, instance_id, labels, reported_at, report) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [row.nodeId, row.instance, JSON.stringify(row.labels), row.reportedAt, JSON.stringify(row.report)],
  );
  return r.changes > 0;
}

export async function listNodePlugins(): Promise<NodePluginsRow[]> {
  const rows = await db.query<Row>(`SELECT node_id, instance_id, labels, reported_at, report FROM node_plugins ORDER BY node_id, instance_id`);
  return rows.flatMap((r) => parseRow(r) ?? []);
}

/** Remove the given process rows. */
export async function deleteNodePluginInstances(instances: readonly string[]): Promise<void> {
  for (const id of instances) await db.run(`DELETE FROM node_plugins WHERE instance_id = ?`, [id]);
}
