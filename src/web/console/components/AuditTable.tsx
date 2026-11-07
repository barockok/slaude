import type { ReactNode } from "react";
import type { AuditEventView } from "../../../gateway/panel/api-types";
import { Badge, Table, type Column } from "../../ui";
import { actionLabel, actorKindLabel, auditAgent, auditTarget, decisionLabel, decisionTone } from "../lib/format";
import { TimeAgo } from "../../shared/TimeAgo";

const COLUMNS: Column<AuditEventView>[] = [
  { key: "at", header: "Time", width: "8.5rem", render: (e) => <TimeAgo at={e.at} />, skeleton: 0.6 },
  {
    key: "actor",
    header: "Actor",
    width: "18%",
    skeleton: 0.7,
    render: (e) => (
      <span className="sl-stack">
        <span className="sl-mono sl-truncate">{e.actorId}</span>
        <span className="sl-caption">{actorKindLabel(e)}</span>
      </span>
    ),
  },
  {
    key: "action",
    header: "Action",
    skeleton: 0.8,
    render: (e) => (
      <span className="sl-stack">
        <span>{actionLabel(e.action)}</span>
        {e.summary && <span className="sl-caption sl-truncate">{e.summary}</span>}
      </span>
    ),
  },
  {
    key: "target",
    header: "Target",
    width: "20%",
    skeleton: 0.6,
    render: (e) => {
      const t = auditTarget(e);
      return t ? <span className="sl-mono sl-truncate">{t}</span> : null;
    },
  },
  {
    key: "decision",
    header: "Decision",
    width: "7.5rem",
    skeleton: 0.5,
    render: (e) => (e.decision ? <Badge tone={decisionTone(e.decision)}>{decisionLabel(e.decision)}</Badge> : null),
  },
];

const AGENT_COLUMN: Column<AuditEventView> = {
  key: "persona",
  header: "Agent",
  width: "9%",
  skeleton: 0.6,
  render: (e) => auditAgent(e) ?? <span className="sl-faint">Console</span>,
};

export interface AuditTableProps {
  label: string;
  rows: AuditEventView[];
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
  showAgent?: boolean;
  onRowClick?: (e: AuditEventView) => void;
}

export function AuditTable({ label, rows, loading, skeletonRows, empty, showAgent, onRowClick }: AuditTableProps) {
  const columns = showAgent ? [COLUMNS[0]!, AGENT_COLUMN, ...COLUMNS.slice(1)] : COLUMNS;
  return (
    <Table
      label={label}
      className="sl-audit-table"
      columns={columns}
      rows={rows}
      rowKey={(e) => e.id}
      loading={loading}
      skeletonRows={skeletonRows}
      empty={empty}
      onRowClick={onRowClick}
    />
  );
}
