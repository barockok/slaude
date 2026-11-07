import { useEffect, useState } from "react";
import type { AgentGrantsResponse, AgentsResponse, ConsoleGrantView, ConsoleRolesResponse } from "../../../gateway/panel/api-types";
import { Link, navigate } from "../../lib/router";
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton, Table, type Column } from "../../ui";
import { api } from "../client";
import { ErrorState } from "../components/ErrorState";
import { RoleBadge, Subject } from "../components/GrantParts";
import { useApi } from "../hooks/useApi";
import { absoluteTime, expiryLabel, shortDate } from "../lib/format";
import { agentPath } from "./agent/AgentDetailPage";

type AgentGrant = ConsoleGrantView & { agent: string };

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

const COLUMNS: Column<AgentGrant>[] = [
  {
    key: "agent",
    header: "Agent",
    width: "14%",
    skeleton: 0.6,
    render: (g) => (
      <Link to={agentPath(g.agent, "access")} className="sl-link" onClick={(e) => e.stopPropagation()}>
        {g.agent}
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

/** Every agent's console grants, fetched agent by agent from the agents list. */
function useAllGrants(agents: string[] | null) {
  const [state, setState] = useState<{ rows: AgentGrant[] | null; error: Error | null }>({ rows: null, error: null });
  const [tick, setTick] = useState(0);
  const key = agents?.join("\n") ?? null;

  useEffect(() => {
    if (key === null || !agents) return;
    const ctl = new AbortController();
    setState({ rows: null, error: null });
    Promise.all(
      agents.map((a) =>
        api
          .get<AgentGrantsResponse>(`/api/agents/${encodeURIComponent(a)}/grants`, { signal: ctl.signal })
          .then((r) => r.grants.filter((g): g is ConsoleGrantView => g.source === "console").map((g) => ({ ...g, agent: a }))),
      ),
    ).then(
      (lists) => setState({ rows: lists.flat().sort((x, y) => y.createdAt - x.createdAt), error: null }),
      (e: Error) => !ctl.signal.aborted && setState({ rows: null, error: e }),
    );
    return () => ctl.abort();
    // `agents` is a new array each render; `key` is its stable identity.
  }, [key, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function AccessPage() {
  const roles = useApi<ConsoleRolesResponse>("/api/console-roles");
  const agents = useApi<AgentsResponse>("/api/agents");
  const grants = useAllGrants(agents.data ? agents.data.agents.map((a) => a.name) : null);
  const grantsError = agents.error ?? grants.error;

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
        {roles.error && !roles.data ? (
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
        {grantsError && !grants.rows ? (
          <Card>
            <ErrorState
              what="Agent grants"
              error={grantsError}
              onRetry={() => (agents.error ? agents.reload() : grants.reload())}
            />
          </Card>
        ) : (
          <Table
            label="Agent grants"
            columns={COLUMNS}
            rows={grants.rows ?? []}
            rowKey={(g) => g.id}
            loading={!grants.rows}
            skeletonRows={4}
            onRowClick={(g) => navigate(agentPath(g.agent, "access"))}
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
