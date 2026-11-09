import { useState } from "react";
import type {
  ConnectIntegrationResponse, DisconnectIntegrationResponse, IntegrationsResponse, IntegrationView,
} from "../../../gateway/portal/api-types";
import { ApiError } from "../../lib/api";
import { Badge, Button, Card, Dialog, EmptyState, PageHeader, Table, useToast, type Column } from "../../ui";
import { ErrorState } from "../../shared/ErrorState";
import { absoluteTime } from "../../shared/time";
import { api, useApi } from "../client";
import { connectionDetail } from "../lib/labels";

const usedByText = (i: IntegrationView) => (i.usedBy.length === 0 ? "No agent" : i.usedBy.join(", "));

function columns(
  busyId: string | null,
  onConnect: (i: IntegrationView) => void,
  onDisconnect: (i: IntegrationView) => void,
): Column<IntegrationView>[] {
  return [
    {
      key: "name",
      header: "Integration",
      skeleton: 0.6,
      render: (i) => (
        <span className="sl-stack">
          <span className="sl-identity__name">{i.name}</span>
          <span className="sl-caption sl-mono sl-truncate" title={i.host}>{i.host}</span>
          {i.plugin && <span className="sl-caption sl-truncate" title={`From plugin ${i.plugin}`}>From plugin {i.plugin}</span>}
        </span>
      ),
    },
    {
      key: "usedBy",
      header: "Used by",
      width: "22%",
      skeleton: 0.5,
      render: (i) => <span className="sl-truncate" title={usedByText(i)}>{usedByText(i)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "30%",
      skeleton: 0.5,
      render: (i) =>
        i.connected ? (
          <span className="sl-stack pt-status">
            <Badge tone="success">Connected</Badge>
            {i.expiresAt != null && (
              <span className="sl-caption" title={absoluteTime(i.expiresAt)}>
                {connectionDetail(i.expiresAt)}
              </span>
            )}
          </span>
        ) : (
          <span className="pt-status">
            <Badge>Not connected</Badge>
          </span>
        ),
    },
    {
      key: "actions",
      header: <span className="sl-visually-hidden">Actions</span>,
      width: "8rem",
      align: "end",
      skeleton: 0.6,
      render: (i) =>
        i.connected ? (
          <Button size="sm" variant="ghost" onClick={() => onDisconnect(i)} disabled={busyId !== null} aria-label={`Disconnect ${i.name}`}>
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => onConnect(i)}
            loading={busyId === i.id}
            disabled={busyId !== null && busyId !== i.id}
            aria-label={`Connect ${i.name}`}
          >
            Connect
          </Button>
        ),
    },
  ];
}

export function IntegrationsPage() {
  const { data, loading, error, reload } = useApi<IntegrationsResponse>("/api/integrations");
  const toast = useToast();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<IntegrationView | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async (i: IntegrationView) => {
    setConnecting(i.id);
    try {
      const { authorizeUrl } = await api.post<ConnectIntegrationResponse>(`/api/integrations/${encodeURIComponent(i.id)}/connect`);
      // The browser leaves for the service's sign-in here. It comes back
      // through /portal/oauth/callback, which redirects to /portal?connect=...
      location.assign(authorizeUrl);
    } catch (e) {
      setConnecting(null);
      const msg = e instanceof ApiError && e.status === 404 ? "This integration is no longer offered. Reload the list." : (e as Error).message;
      toast({ tone: "danger", title: `Could not connect ${i.name}`, description: msg });
    }
  };

  const disconnect = async () => {
    if (!disconnecting) return;
    const name = disconnecting.name;
    setBusy(true);
    try {
      const r = await api.del<DisconnectIntegrationResponse>(`/api/integrations/${encodeURIComponent(disconnecting.id)}`);
      toast(
        r.removed
          ? { tone: "success", title: `${name} disconnected`, description: "Agents can no longer use it on your behalf." }
          : { title: "Already disconnected", description: `${name} had no connection to remove.` },
      );
      setDisconnecting(null);
      reload();
    } catch (e) {
      toast({ tone: "danger", title: `Could not disconnect ${name}`, description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Integrations" description="Connect the tools your agents use on your behalf." />
      <p className="pt-note">
        Connections are personal. An agent uses them only when it works for you: in your <code className="sl-mono">/1on1</code> with it and in
        anything you schedule there. In a channel thread it uses its own access instead.
      </p>
      {error && !data ? (
        <Card>
          <ErrorState what="Integrations" error={error} onRetry={reload} />
        </Card>
      ) : (
        <Table
          className="pt-stack"
          label="Integrations"
          columns={columns(connecting, connect, setDisconnecting)}
          rows={data?.integrations ?? []}
          rowKey={(i) => i.id}
          loading={loading && !data}
          skeletonRows={3}
          empty={
            <EmptyState
              title="No integrations to connect"
              description="None of this deployment's agents use a service that signs in per person. When an operator adds one, it appears here."
            />
          }
        />
      )}

      <Dialog
        open={disconnecting !== null}
        onClose={() => (busy ? undefined : setDisconnecting(null))}
        size="sm"
        title={disconnecting ? `Disconnect ${disconnecting.name}?` : "Disconnect?"}
        description={
          disconnecting
            ? `This removes your stored access to ${disconnecting.name}. Agents can no longer use it on your behalf until you connect it again.`
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setDisconnecting(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={disconnect}>
              Disconnect
            </Button>
          </>
        }
      />
    </>
  );
}
