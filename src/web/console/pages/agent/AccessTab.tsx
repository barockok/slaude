import { useState } from "react";
import type { AgentDetailResponse, ConsoleGrantView, GrantView } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Badge, Button, Dialog, EmptyState, IconLock, IconPlus, Table, useToast, type Column } from "../../../ui";
import { api } from "../../client";
import { RoleBadge, Subject } from "../../components/GrantParts";
import { useRole } from "../../hooks/useRole";
import { absoluteTime, expiryLabel, shortDate } from "../../lib/format";
import { ROLE_LABEL, SUBJECT_LABEL } from "../../lib/grants";
import { GrantDialog } from "./GrantDialog";

export const PROPAGATION_NOTE = "Changes apply on this gateway immediately and on other replicas within a few seconds.";

const grantKey = (g: GrantView) =>
  g.source === "console" ? g.id : `soul:${g.subjectKind}:${g.subjectId}:${g.role}:${g.channelId ?? ""}:${g.deny}`;

/** "the member grant for user UBOB", or "the deny for user UCAROL". */
function describe(g: GrantView): string {
  const what = g.deny ? "deny" : `${ROLE_LABEL[g.role].toLowerCase()} grant`;
  return `the ${what} for ${SUBJECT_LABEL[g.subjectKind].toLowerCase()} ${g.subjectId}`;
}

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

export function AccessTab({ agent, onChanged }: { agent: AgentDetailResponse; onChanged: () => void }) {
  const role = useRole();
  const canEdit = role === "superadmin";
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<ConsoleGrantView | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.del(`/api/agents/${encodeURIComponent(agent.name)}/grants/${encodeURIComponent(revoking.id)}`);
      toast({ tone: "success", title: "Grant revoked", description: `Revoked ${describe(revoking)}.` });
      setRevoking(null);
      onChanged();
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 403 ? "Only a superadmin can change grants." : (e as Error).message;
      toast({ tone: "danger", title: "Could not revoke the grant", description: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sl-section sl-section--flush">
      <div className="sl-section__head">
        <div>
          <h2 className="sl-section__title">Effective grants</h2>
          <p className="sl-caption">
            {canEdit ? PROPAGATION_NOTE : "You can view grants. Ask a superadmin to add or revoke one."}
          </p>
        </div>
        {canEdit && (
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setAdding(true)}>
            Add grant
          </Button>
        )}
      </div>

      <Table
        label={`Grants on ${agent.name}`}
        columns={columns(canEdit, setRevoking)}
        rows={agent.grants}
        rowKey={grantKey}
        empty={
          <EmptyState
            title="No grants"
            description={
              canEdit
                ? "Nobody holds a role on this agent yet. Add a grant, or list approvers and channels in its SOUL.md."
                : "Nobody holds a role on this agent yet."
            }
          />
        }
      />

      <GrantDialog
        agent={agent.name}
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(g) => {
          setAdding(false);
          toast({ tone: "success", title: "Grant added", description: `Added ${describe(g)} on ${agent.name}.` });
          onChanged();
        }}
      />

      <Dialog
        open={revoking !== null}
        onClose={() => (busy ? undefined : setRevoking(null))}
        size="sm"
        title="Revoke grant?"
        description={revoking ? `This removes ${describe(revoking)} on ${agent.name}. ${PROPAGATION_NOTE}` : undefined}
        footer={
          <>
            <Button onClick={() => setRevoking(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={revoke}>
              Revoke
            </Button>
          </>
        }
      />
    </section>
  );
}
