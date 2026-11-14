import { useState } from "react";
import type { StateCounts, UserDetail, UserListItem } from "../../../../gateway/panel/api-types";
import { Badge, EmptyState, KeyValue, PageHeader, Table, type Column } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { Drawer } from "../../components/Drawer";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { absoluteTime } from "../../lib/format";
import { DomainList, READ_ONLY_NOTE, STATE_TONE } from "./DomainList";

const counts = (c: StateCounts) => (
  <span className="sl-nowrap">
    {c.verified} verified, {c.observed} observed, {c.declared} declared
  </span>
);

const COLUMNS: Column<UserListItem>[] = [
  { key: "who", header: "User", skeleton: 0.7, render: (u) => (
    <span className="sl-stack">
      <span className="sl-truncate">{u.preferred ?? <span className="sl-faint">No bindings</span>}</span>
      <span className="sl-caption sl-mono sl-truncate">{u.id}</span>
    </span>
  ) },
  { key: "kind", header: "Kind", width: "6rem", skeleton: 0.5, render: (u) => u.kind },
  { key: "bindings", header: "Bindings", width: "20%", skeleton: 0.7, render: (u) => counts(u.bindings) },
  { key: "aliases", header: "Aliases", width: "5.5rem", align: "end", skeleton: 0.4, render: (u) => u.aliasCount },
  { key: "flags", header: "Flags", width: "7rem", skeleton: 0.5, render: (u) => (u.unmatched ? <Badge tone="warning">Unmatched</Badge> : null) },
  { key: "created", header: "Created", width: "8.5rem", skeleton: 0.6, render: (u) => <TimeAgo at={u.createdAt} /> },
];

export function UsersPage() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Users" description={`People and bots the deployment knows, with how each was matched. ${READ_ONLY_NOTE}`} />
      <DomainList<UserListItem>
        route="/users"
        endpoint="/api/users"
        label="Users"
        columns={COLUMNS}
        rowKey={(u) => u.id}
        searchLabel="Search by binding value"
        searchPlaceholder="Start of an id or address"
        emptyTitle="No users yet"
        emptyDescription="Users appear as people message an agent, link their account or are named in an agent definition."
        onRowClick={(u) => setOpen(u.id)}
      />
      <UserDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

function UserDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const d = useApi<UserDetail>(id ? `/api/users/${encodeURIComponent(id)}` : null);
  const u = id ? d.data : null;
  return (
    <Drawer open={!!id} onClose={onClose} title="User" description={id ?? undefined}>
      {d.error && !u && <ErrorState what="This user" error={d.error} onRetry={d.reload} />}
      {u && (
        <div className="sl-stack-lg">
          <KeyValue
            className="sl-kv--compact"
            items={[
              { key: "kind", label: "Kind", value: u.kind },
              { key: "name", label: "Display name", value: u.displayName ?? <span className="sl-faint">None</span> },
              { key: "created", label: "Created", value: absoluteTime(u.createdAt) },
              { key: "flag", label: "Unmatched", value: u.unmatched ? "Yes: every binding is declared and none was seen in seven days" : "No" },
            ]}
          />
          <h3 className="sl-subhead">Bindings</h3>
          {u.bindings.length === 0 ? (
            <EmptyState title="No bindings" description="This user holds no service identity." />
          ) : (
            <Table<UserDetail["bindings"][number]>
              label="Bindings"
              rows={u.bindings}
              rowKey={(b) => b.id}
              columns={[
                { key: "svc", header: "Service", width: "6rem", render: (b) => `${b.service} ${b.kind}` },
                { key: "val", header: "Value", render: (b) => (
                  <span className="sl-stack">
                    <span className="sl-mono sl-break">{b.value}</span>
                    {b.workspace && <span className="sl-caption sl-mono sl-break">{b.workspace}</span>}
                  </span>
                ) },
                { key: "state", header: "State", width: "6rem", render: (b) => <Badge tone={STATE_TONE[b.state]}>{b.state}</Badge> },
                { key: "src", header: "Source", width: "6rem", render: (b) => b.source || <span className="sl-faint">None</span> },
              ]}
            />
          )}
          <h3 className="sl-subhead">Aliases</h3>
          {u.aliases.length === 0 ? (
            <p className="sl-caption">No merged ids point here.</p>
          ) : (
            <ul className="sl-stack">
              {u.aliases.map((a) => (
                <li key={a.oldId}>
                  <span className="sl-mono sl-break">{a.oldId}</span> <span className="sl-caption">merged {absoluteTime(a.mergedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="sl-caption">{READ_ONLY_NOTE}</p>
        </div>
      )}
    </Drawer>
  );
}
