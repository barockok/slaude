import type { MyAgentsResponse, MyAgentView, PortalMeResponse } from "../../../gateway/portal/api-types";
import { Avatar, Card, EmptyState, IconBuilding, PageHeader, Table, type Column } from "../../ui";
import { ErrorState } from "../../shared/ErrorState";
import { RoleBadge } from "../../shared/RoleBadge";
import { useApi } from "../client";
import { NamedId } from "../../shared/NamedId";
import { capitalize, sendCommandGuidance, surfaceInfo } from "../../shared/surfaces";

const COLUMNS: Column<MyAgentView>[] = [
  {
    key: "persona",
    header: "Agent",
    skeleton: 0.5,
    render: (a) => (
      <span className="sl-identity">
        <Avatar name={a.persona} size="sm" />
        <span className="sl-identity__name">{a.persona}</span>
      </span>
    ),
  },
  { key: "surface", header: "Surface", width: "10%", skeleton: 0.5, render: (a) => <span className="sl-nowrap">{surfaceInfo(a.surface).label}</span> },
  {
    key: "team",
    header: "Workspace",
    width: "22%",
    skeleton: 0.6,
    render: (a) => (
      <span className="sl-subject">
        <span className="sl-subject__icon" title={`${surfaceInfo(a.surface).label} workspace`}>
          <IconBuilding size={14} />
        </span>
        <NamedId name={a.teamName} id={a.teamId} />
      </span>
    ),
  },
  { key: "user", header: "As user", width: "20%", skeleton: 0.6, render: (a) => <NamedId name={a.userName} id={a.slackUserId} /> },
  { key: "role", header: "Your role", width: "9rem", skeleton: 0.5, render: (a) => <RoleBadge role={a.role} /> },
];

/**
 * The empty list, said for the reason it is empty: with no chat identity
 * linked, no person grant can match the account yet (link first); with one
 * linked, nobody granted a role yet.
 */
export function NoAgents({ me }: { me: PortalMeResponse | null }) {
  if (me && me.slackIdentities.length === 0) {
    return (
      <EmptyState
        title="No chat identity linked"
        description={
          <>
            Roles are granted to your chat user, and your account has none linked yet. {capitalize(sendCommandGuidance("/link"))}, in a
            conversation with any agent. It replies with a private link; open it while signed in here and confirm. Your agents show up here afterwards.
          </>
        }
      />
    );
  }
  return <EmptyState title="No agents yet" description="Ask an agent's manager to grant you access." />;
}

export function MyAgentsPage() {
  const { data, loading, error, reload } = useApi<MyAgentsResponse>("/api/my-agents");
  const me = useApi<PortalMeResponse>("/api/me");
  return (
    <>
      <PageHeader title="My agents" description="Agents you can work with, and your role on each." />
      <p className="pt-note">
        This lists roles granted to you as a person, for each chat identity linked to your account. Access you have through a channel or a whole
        workspace is not listed.
      </p>
      {error && !data ? (
        <Card>
          <ErrorState what="Your agents" error={error} onRetry={reload} />
        </Card>
      ) : (
        <Table
          className="pt-stack"
          label="My agents"
          columns={COLUMNS}
          rows={data?.agents ?? []}
          rowKey={(a) => `${a.persona}:${a.surface}:${a.teamId}:${a.slackUserId}`}
          loading={(loading && !data) || (data?.agents.length === 0 && me.loading && !me.data)}
          skeletonRows={3}
          empty={<NoAgents me={me.data ?? null} />}
        />
      )}
    </>
  );
}
