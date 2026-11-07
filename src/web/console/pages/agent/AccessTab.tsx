import type { AgentDetailResponse, ConsoleGrantView, GrantView } from "../../../../gateway/panel/api-types";
import { Badge, Button, EmptyState, IconLock, Table, type Column } from "../../../ui";
import { RoleBadge, Subject } from "../../components/GrantParts";
import { absoluteTime, expiryLabel, shortDate } from "../../lib/format";

const grantKey = (g: GrantView) =>
  g.source === "console" ? g.id : `soul:${g.subjectKind}:${g.subjectId}:${g.role}:${g.channelId ?? ""}:${g.deny}`;

function columns(canEdit: boolean, onRevoke: (g: ConsoleGrantView) => void): Column<GrantView>[] {
  const cols: Column<GrantView>[] = [
    {
      key: "subject",
      header: "Subject",
      skeleton: 0.6,
      render: (g) => (
        <Subject
          kind={g.subjectKind}
          id={g.subjectId}
          sub={g.source === "soul" ? (g.channelId ? `In #${g.channelId} only` : null) : g.note}
        />
      ),
    },
    { key: "role", header: "Role", width: "8rem", skeleton: 0.5, render: (g) => <RoleBadge role={g.role} /> },
    { key: "deny", header: "Deny", width: "5rem", skeleton: 0.4, render: (g) => (g.deny ? <Badge tone="danger">Deny</Badge> : <span className="sl-faint">No</span>) },
    { key: "dm", header: "DM only", width: "5.5rem", skeleton: 0.4, render: (g) => (g.dmOnly ? <Badge>DM only</Badge> : <span className="sl-faint">No</span>) },
    {
      key: "source",
      header: "Source",
      width: "9rem",
      skeleton: 0.6,
      render: (g) =>
        g.source === "soul" ? (
          <span className="sl-source" title="Edit SOUL.md to change">
            <IconLock size={12} />
            From SOUL.md
          </span>
        ) : (
          <Badge tone="accent">Console</Badge>
        ),
    },
    {
      key: "expires",
      header: "Expires",
      width: "7rem",
      skeleton: 0.5,
      render: (g) =>
        g.source === "console" && g.expiresAt ? (
          <span title={absoluteTime(g.expiresAt)}>{expiryLabel(g.expiresAt)}</span>
        ) : (
          <span className="sl-faint">Never</span>
        ),
    },
    {
      key: "by",
      header: "Created by",
      width: "15%",
      skeleton: 0.6,
      render: (g) =>
        g.source === "console" ? (
          <span className="sl-stack">
            <span className="sl-truncate" title={g.createdBy}>{g.createdBy}</span>
            <span className="sl-caption" title={absoluteTime(g.createdAt)}>{shortDate(g.createdAt)}</span>
          </span>
        ) : (
          <span className="sl-faint">Soul</span>
        ),
    },
  ];
  if (canEdit) {
    cols.push({
      key: "actions",
      header: <span className="sl-visually-hidden">Actions</span>,
      width: "6rem",
      align: "end",
      skeleton: 0.6,
      render: (g) =>
        g.source === "console" ? (
          <Button size="sm" variant="ghost" onClick={() => onRevoke(g)}>
            Revoke
          </Button>
        ) : null,
    });
  }
  return cols;
}

export function AccessTab({ agent }: { agent: AgentDetailResponse; onChanged: () => void }) {
  return (
    <section className="sl-section sl-section--flush">
      <div className="sl-section__head">
        <div>
          <h2 className="sl-section__title">Effective grants</h2>
          <p className="sl-caption">Grants from SOUL.md and from the console, as admission sees them.</p>
        </div>
      </div>
      <Table
        label={`Grants on ${agent.name}`}
        columns={columns(false, () => undefined)}
        rows={agent.grants}
        rowKey={grantKey}
        empty={<EmptyState title="No grants" description="Nobody holds a role on this agent yet." />}
      />
    </section>
  );
}
