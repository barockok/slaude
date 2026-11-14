import type { BoundaryListItem } from "../../../../gateway/panel/api-types";
import { Badge, PageHeader, type Column } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { DomainList, READ_ONLY_NOTE, STATE_TONE } from "./DomainList";

const COLUMNS: Column<BoundaryListItem>[] = [
  { key: "name", header: "Boundary", skeleton: 0.7, render: (b) => (
    <span className="sl-stack">
      <span className="sl-mono sl-truncate">{b.value}</span>
      {b.displayName && <span className="sl-caption sl-truncate">{b.displayName}</span>}
    </span>
  ) },
  { key: "kind", header: "Kind", width: "6rem", skeleton: 0.5, render: (b) => b.kind },
  { key: "service", header: "Service", width: "6rem", skeleton: 0.5, render: (b) => b.service },
  { key: "ws", header: "Workspace", width: "10rem", skeleton: 0.6, render: (b) => (b.workspace ? <span className="sl-mono sl-truncate">{b.workspace}</span> : <span className="sl-faint">None</span>) },
  { key: "state", header: "State", width: "6.5rem", skeleton: 0.5, render: (b) => <Badge tone={STATE_TONE[b.state]}>{b.state}</Badge> },
  { key: "flags", header: "Flags", width: "7rem", skeleton: 0.5, render: (b) => (b.unmatched ? <Badge tone="warning">Unmatched</Badge> : null) },
  { key: "created", header: "Created", width: "8.5rem", skeleton: 0.6, render: (b) => <TimeAgo at={b.createdAt} /> },
];

export function BoundariesPage() {
  return (
    <>
      <PageHeader title="Boundaries" description={`Channels and groups the deployment knows. ${READ_ONLY_NOTE}`} />
      <DomainList<BoundaryListItem>
        route="/boundaries"
        endpoint="/api/boundaries"
        label="Boundaries"
        columns={COLUMNS}
        rowKey={(b) => b.id}
        searchLabel="Search by channel or group id"
        searchPlaceholder="Start of an id"
        emptyTitle="No boundaries yet"
        emptyDescription="Channels appear as agents are used in them or named in an agent definition."
      />
    </>
  );
}
