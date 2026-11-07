import type { ReactNode } from "react";
import type { EnvironmentsResponse, NodePoolView, PersonalEnvironmentView } from "../../../gateway/panel/api-types";
import { Link } from "../../lib/router";
import { Avatar, Badge, Card, EmptyState, PageHeader, Skeleton, Table, type Column } from "../../ui";
import { ErrorState } from "../components/ErrorState";
import { TimeAgo } from "../components/TimeAgo";
import { useApi } from "../hooks/useApi";

type Placement = EnvironmentsResponse["personas"][number];

function Section({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <section className="sl-section">
      <div className="sl-section__head">
        <div>
          <h2 className="sl-section__title">{title}</h2>
          <p className="sl-caption">{caption}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function PoolCard({ pool, agents }: { pool: NodePoolView; agents: string[] }) {
  const n = pool.nodes.length;
  return (
    <div className="sl-pool">
      <div className="sl-pool__head">
        <span className="sl-mono sl-pool__label">{pool.label}</span>
        {n > 0 ? <Badge tone="success">{`${n} live ${n === 1 ? "node" : "nodes"}`}</Badge> : <Badge tone="warning">No live node</Badge>}
      </div>
      {n > 0 ? (
        <ul className="sl-pool__nodes">
          {pool.nodes.map((node) => (
            <li key={node.id}>
              <span className="sl-dot is-ok" aria-hidden="true" />
              <span className="sl-mono sl-truncate">{node.id}</span>
              <span className="sl-caption sl-pool__seen">{node.lastSeen ? <>Seen <TimeAgo at={node.lastSeen} /></> : "Last seen unknown"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sl-caption">
          Turns for this label wait in the queue until a node that carries it connects.
        </p>
      )}
      <p className="sl-caption sl-pool__agents">
        {agents.length ? <>Serves {agents.join(", ")}</> : "No agent runs on this label"}
      </p>
    </div>
  );
}

function placementColumns(cluster: boolean, live: Map<string, number>): Column<Placement>[] {
  return [
    {
      key: "agent",
      header: "Agent",
      skeleton: 0.5,
      render: (p) => (
        <Link className="sl-identity sl-link-plain" to={`/agents/${encodeURIComponent(p.name)}`}>
          <Avatar name={p.name} size="sm" />
          <span className="sl-identity__name">{p.name}</span>
        </Link>
      ),
    },
    { key: "runsOn", header: "Runs on", width: "30%", skeleton: 0.5, render: (p) => <span className="sl-mono">{p.runsOn}</span> },
    {
      key: "state",
      header: "Capacity",
      width: "30%",
      skeleton: 0.4,
      render: (p) => {
        if (!cluster) return <span className="sl-faint">This process</span>;
        const n = live.get(p.runsOn) ?? 0;
        return n > 0 ? (
          <Badge tone="success">{`${n} live ${n === 1 ? "node" : "nodes"}`}</Badge>
        ) : (
          <Badge tone="warning">No live node carries this label</Badge>
        );
      },
    },
  ];
}

const PERSONAL_COLUMNS: Column<PersonalEnvironmentView>[] = [
  {
    key: "owner",
    header: "Owner",
    width: "18%",
    skeleton: 0.6,
    render: (e) => (
      <span className="sl-stack">
        <span className="sl-mono">{e.owner.userId}</span>
        <span className="sl-caption sl-mono">{e.owner.teamId}</span>
      </span>
    ),
  },
  { key: "name", header: "Name", width: "18%", skeleton: 0.5, render: (e) => <span className="sl-identity__name">{e.name}</span> },
  { key: "kind", header: "Kind", width: "12%", skeleton: 0.4, render: (e) => <Badge>{e.kind}</Badge> },
  {
    key: "dir",
    header: "Default directory",
    skeleton: 0.6,
    render: (e) => (e.defaultDir ? <span className="sl-mono sl-truncate">{e.defaultDir}</span> : <span className="sl-faint">Home directory</span>),
  },
  { key: "created", header: "Created", width: "9rem", skeleton: 0.5, render: (e) => <TimeAgo at={e.createdAt} /> },
];

export function EnvironmentsPage() {
  const { data, loading, error, reload } = useApi<EnvironmentsResponse>("/api/environments");

  const header = <PageHeader title="Environments" description="Where agents run: node pools, placement and personal environments." />;

  if (error && !data) {
    return (
      <>
        {header}
        <Card>
          <ErrorState what="Environments" error={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  const pools = data?.nodePools ?? [];
  const cluster = pools.length > 0;
  const live = new Map(pools.map((p) => [p.label, p.nodes.length]));
  const agentsOn = (label: string) => (data?.personas ?? []).filter((p) => p.runsOn === label).map((p) => p.name);
  const unplaced = cluster ? (data?.personas ?? []).filter((p) => (live.get(p.runsOn) ?? 0) === 0) : [];

  return (
    <>
      {header}

      <Section title="Node pools" caption="Nodes grouped by the labels they carry, with their last heartbeat.">
        {loading && !data ? (
          <div className="sl-pools">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="8.5rem" radius="var(--sl-radius-panel)" />
            ))}
          </div>
        ) : cluster ? (
          <div className="sl-pools">
            {pools.map((p) => (
              <PoolCard key={p.label} pool={p} agents={agentsOn(p.label)} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              title="No node pools"
              description="This deployment runs as a single process, or has no node registry to ask: every agent turn runs inside the gateway itself. Node pools appear here when nodes connect to a gateway with a queue."
            />
          </Card>
        )}
      </Section>

      <Section title="Agent placement" caption="The label each agent's turns are sent to.">
        {unplaced.length > 0 && (
          <p className="sl-notice is-warning" role="status">
            {unplaced.length === 1
              ? `${unplaced[0]!.name} runs on ${unplaced[0]!.runsOn}, and no live node carries that label. Its turns wait until one connects.`
              : `${unplaced.length} agents run on labels no live node carries. Their turns wait until a node connects.`}
          </p>
        )}
        <Table
          label="Agent placement"
          columns={placementColumns(cluster, live)}
          rows={data?.personas ?? []}
          rowKey={(p) => p.name}
          loading={loading && !data}
          skeletonRows={3}
          empty={<EmptyState title="No agents" description="Agents appear here once they are defined." />}
        />
      </Section>

      <Section
        title="Personal environments"
        caption="Machines people saved for their own threads. Connection details and secrets are never shown here."
      >
        <Table
          label="Personal environments"
          columns={PERSONAL_COLUMNS}
          rows={data?.personal ?? []}
          rowKey={(e) => e.id}
          loading={loading && !data}
          skeletonRows={3}
          empty={
            <EmptyState
              title="No personal environments"
              description="People add one from Slack with /env, to run a thread's shell and file tools on their own machine."
            />
          }
        />
      </Section>
    </>
  );
}
