import { useState } from "react";
import type { PortalMeResponse, PortalSlackIdentityView, UnlinkRequest } from "../../../gateway/portal/api-types";
import { ApiError } from "../../lib/api";
import { Avatar, Button, Card, Dialog, EmptyState, IconBuilding, PageHeader, Skeleton, Table, useToast, type Column } from "../../ui";
import { ErrorState } from "../../shared/ErrorState";
import { absoluteTime, shortDate } from "../../shared/time";
import { api, useApi } from "../client";
import { linkedViaLabel } from "../lib/labels";

const idKey = (s: PortalSlackIdentityView) => `${s.teamId}:${s.slackUserId}`;

function hostOf(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

function columns(onUnlink: (s: PortalSlackIdentityView) => void): Column<PortalSlackIdentityView>[] {
  return [
    {
      key: "team",
      header: "Workspace",
      skeleton: 0.6,
      render: (s) => (
        <span className="sl-subject">
          <span className="sl-subject__icon" title="Slack workspace">
            <IconBuilding size={14} />
          </span>
          <span className="sl-mono">{s.teamId}</span>
        </span>
      ),
    },
    { key: "user", header: "Slack user", width: "22%", skeleton: 0.6, render: (s) => <span className="sl-mono">{s.slackUserId}</span> },
    { key: "via", header: "Linked via", width: "20%", skeleton: 0.6, render: (s) => <span className="sl-nowrap">{linkedViaLabel(s.linkedVia)}</span> },
    {
      key: "at",
      header: "Linked",
      width: "16%",
      skeleton: 0.5,
      render: (s) => (
        <time className="sl-nowrap" dateTime={new Date(s.linkedAt).toISOString()} title={absoluteTime(s.linkedAt)}>
          {shortDate(s.linkedAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: <span className="sl-visually-hidden">Actions</span>,
      width: "6rem",
      align: "end",
      skeleton: 0.6,
      render: (s) => (
        <Button size="sm" variant="ghost" onClick={() => onUnlink(s)} aria-label={`Unlink ${s.slackUserId} in ${s.teamId}`}>
          Unlink
        </Button>
      ),
    },
  ];
}

function Profile({ me }: { me: PortalMeResponse | null }) {
  return (
    <Card className="pt-profile">
      <div className="pt-profile__row">
        {me ? <Avatar name={me.email} /> : <Skeleton width="2rem" height="2rem" radius="999px" />}
        <div className="sl-stack">
          {me ? (
            <>
              <span className="pt-profile__email sl-break">{me.email}</span>
              <span className="sl-caption sl-break" title={me.issuer}>
                Signed in through {hostOf(me.issuer)}
              </span>
            </>
          ) : (
            <>
              <Skeleton width="12rem" height="1.25rem" />
              <Skeleton width="9rem" height="1rem" />
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

export function AccountPage() {
  const { data: me, loading, error, reload } = useApi<PortalMeResponse>("/api/me");
  const toast = useToast();
  const [unlinking, setUnlinking] = useState<PortalSlackIdentityView | null>(null);
  const [busy, setBusy] = useState(false);

  const unlink = async () => {
    if (!unlinking) return;
    const who = `${unlinking.slackUserId} in ${unlinking.teamId}`;
    setBusy(true);
    try {
      await api.del("/api/link", { teamId: unlinking.teamId, slackUserId: unlinking.slackUserId } satisfies UnlinkRequest);
      toast({ tone: "success", title: "Slack identity unlinked", description: `${who} is no longer linked to your account.` });
      setUnlinking(null);
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast({ title: "Already unlinked", description: `${who} was not linked to your account any more.` });
        setUnlinking(null);
        reload();
        return;
      }
      toast({ tone: "danger", title: "Could not unlink", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="My account" description="Your sign-in and the Slack identities linked to it." />
      {error && !me ? (
        <Card>
          <ErrorState what="Your account" error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <Profile me={me} />

          <section className="sl-section">
            <div className="sl-section__head">
              <div>
                <h2 className="sl-section__title">Linked Slack identities</h2>
                <p className="sl-caption">
                  When you message an agent as one of these Slack users, it can use the integrations you connect here.
                </p>
              </div>
            </div>
            <Table
              className="pt-stack"
              label="Linked Slack identities"
              columns={columns(setUnlinking)}
              rows={me?.slackIdentities ?? []}
              rowKey={idKey}
              loading={loading && !me}
              skeletonRows={2}
              empty={
                <EmptyState
                  title="No Slack identity linked yet"
                  description={
                    <>
                      Run <code className="sl-mono">/link</code> in Slack, in a conversation with any agent. It replies with a private link; open it while
                      signed in here and confirm.
                    </>
                  }
                />
              }
            />
          </section>
        </>
      )}

      <Dialog
        open={unlinking !== null}
        onClose={() => (busy ? undefined : setUnlinking(null))}
        size="sm"
        title="Unlink this Slack identity?"
        description={
          unlinking
            ? `Slack user ${unlinking.slackUserId} in ${unlinking.teamId} stops resolving to your account. Agents working for that user no longer use your integrations. Run /link in Slack to link it again.`
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setUnlinking(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={unlink}>
              Unlink
            </Button>
          </>
        }
      />
    </>
  );
}
