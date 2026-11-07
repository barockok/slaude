import type { AllGrantsResponse, ConsoleRolesResponse, PersonaConsoleGrantView } from "../../../gateway/panel/api-types";
import { Link, navigate } from "../../lib/router";
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton, Table, type Column } from "../../ui";
import { ErrorState } from "../components/ErrorState";
import { RoleBadge, Subject } from "../components/GrantParts";
import { useApi } from "../hooks/useApi";
import { useRole } from "../hooks/useRole";
import { absoluteTime, expiryLabel, shortDate } from "../lib/format";
import { agentPath } from "./agent/AgentDetailPage";

function RoleList({ title, description, emails }: { title: string; description: string; emails: string[] | undefined }) {
  return (
    <Card title={title} description={description} className="sl-role-card">
      {!emails ? (
        <div className="sl-stack-lg">
          <Skeleton width="70%" />
          <Skeleton width="55%" />
        </div>
      ) : emails.length === 0 ? (
        <p className="sl-faint">Nobody</p>
      ) : (
        <ul className="sl-people">
          {emails.map((e) => (
            <li key={e} className="sl-person">
              <Avatar name={e} size="sm" />
              <span className="sl-truncate">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const COLUMNS: Column<PersonaConsoleGrantView>[] = [
  {
    key: "agent",
    header: "Agent",
    width: "14%",
    skeleton: 0.6,
    render: (g) => (
      <Link to={agentPath(g.persona, "access")} className="sl-link" onClick={(e) => e.stopPropagation()}>
        {g.persona}
      </Link>
    ),
  },
  {
    key: "subject",
    header: "Subject",
    skeleton: 0.6,
    render: (g) => <Subject kind={g.subjectKind} id={g.subjectId} sub={g.note} />,
  },
  {
    key: "role",
    header: "Role",
    width: "10rem",
    skeleton: 0.5,
    render: (g) => (
      <span className="sl-inline">
        <RoleBadge role={g.role} />
        {g.deny && <Badge tone="danger">Deny</Badge>}
        {g.dmOnly && <Badge>DM only</Badge>}
      </span>
    ),
  },
  {
    key: "expires",
    header: "Expires",
    width: "7rem",
    skeleton: 0.5,
    render: (g) => (g.expiresAt ? <span title={absoluteTime(g.expiresAt)}>{expiryLabel(g.expiresAt)}</span> : <span className="sl-faint">Never</span>),
  },
  {
    key: "by",
    header: "Created by",
    width: "20%",
    skeleton: 0.6,
    render: (g) => (
      <span className="sl-stack">
        <span className="sl-truncate" title={g.createdBy}>{g.createdBy}</span>
        <span className="sl-caption" title={absoluteTime(g.createdAt)}>{shortDate(g.createdAt)}</span>
      </span>
    ),
  },
];

export function AccessPage() {
  const role = useRole();
  // Console roles list every console user's email: superadmins only. An
  // operator never calls the endpoint and sees a note instead.
  const roles = useApi<ConsoleRolesResponse>(role === "superadmin" ? "/api/console-roles" : null);
  const grants = useApi<AllGrantsResponse>("/api/grants");

  return (
    <>
      <PageHeader title="Access" description="Console roles and the grants that decide who can work with each agent." />

      <section className="sl-section">
        <div className="sl-section__head">
          <div>
            <h2 className="sl-section__title">Console roles</h2>
            <p className="sl-caption">Read from the panel roles file on the gateway. Edit that file to change who can sign in.</p>
          </div>
        </div>
        {role === "operator" ? (
          <Card>
            <p className="sl-caption">Only superadmins can see who has console access. Ask a superadmin if you need a role changed.</p>
          </Card>
        ) : roles.error && !roles.data ? (
          <Card>
            <ErrorState what="Console roles" error={roles.error} onRetry={roles.reload} />
          </Card>
        ) : (
          <div className="sl-role-grid">
            <RoleList
              title="Superadmins"
              description="Everything operators can do, plus grant changes and private memory."
              emails={roles.data?.superadmin}
            />
            <RoleList title="Operators" description="Read the console, chat in sessions and take over threads." emails={roles.data?.operator} />
          </div>
        )}
      </section>

      <section className="sl-section">
        <div className="sl-section__head">
          <div>
            <h2 className="sl-section__title">Agent grants</h2>
            <p className="sl-caption">Grants added in the console, across every agent. Grants from SOUL.md show on each agent's Access tab.</p>
          </div>
        </div>
        {grants.error && !grants.data ? (
          <Card>
            <ErrorState what="Agent grants" error={grants.error} onRetry={grants.reload} />
          </Card>
        ) : (
          <Table
            label="Agent grants"
            columns={COLUMNS}
            rows={grants.data?.grants ?? []}
            rowKey={(g) => g.id}
            loading={!grants.data}
            skeletonRows={4}
            onRowClick={(g) => navigate(agentPath(g.persona, "access"))}
            empty={
              <EmptyState
                title="No console grants"
                description="Open an agent's Access tab to give a person, channel or workspace a role on it."
                action={
                  <Link to="/agents" className="sl-btn sl-btn--secondary sl-btn--md">
                    Go to agents
                  </Link>
                }
              />
            }
          />
        )}
      </section>
    </>
  );
}
