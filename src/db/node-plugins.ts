import { db } from "./schema";
import type { PluginReport } from "../config/plugin-inventory";

/** One node credential's latest plugin report (migration 0035). */
export interface NodePluginsRow {
  nodeId: string;
  labels: string[];
  reportedAt: number;
  report: PluginReport;
}

interface Row {
  node_id: string;
  labels: string;
  reported_at: number | string;
  report: string;
}

const parseRow = (r: Row): NodePluginsRow | null => {
  try {
    return {
      nodeId: r.node_id,
      labels: JSON.parse(r.labels) as string[],
      reportedAt: Number(r.reported_at),
      report: JSON.parse(r.report) as PluginReport,
    };
  } catch {
    return null;
  }
};

/** Replace a node's report. */
export async function upsertNodePlugins(row: NodePluginsRow): Promise<void> {
  await db.run(
    `INSERT INTO node_plugins (node_id, labels, reported_at, report) VALUES (?, ?, ?, ?)
     ON CONFLICT (node_id) DO UPDATE SET labels = excluded.labels, reported_at = excluded.reported_at, report = excluded.report`,
    [row.nodeId, JSON.stringify(row.labels), row.reportedAt, JSON.stringify(row.report)],
  );
}

export async function listNodePlugins(): Promise<NodePluginsRow[]> {
  const rows = await db.query<Row>(`SELECT node_id, labels, reported_at, report FROM node_plugins ORDER BY node_id`);
  return rows.flatMap((r) => parseRow(r) ?? []);
}
