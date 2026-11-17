import type { PluginLabelView, PluginView, PluginsResponse } from "../../../../gateway/panel/api-types";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Table, type Column } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";

const shortCommit = (c: string | null | undefined) => (c ? c.slice(0, 7) : "unknown");

const STDIO_NOT_MOUNTED = "not mounted on this node";

function contentsText(p: PluginView): string {
  return [`${p.skills} skills`, `${p.commands} commands`, `${p.agents} agents`, `${p.hooks} hooks`].join(", ");
}

const columns: Column<PluginView>[] = [
  {
    key: "plugin",
    header: "Plugin",
    width: "24%",
    skeleton: 0.6,
    render: (p) => (
      <span className="sl-stack">
        <span className="sl-strong sl-truncate">{p.name}</span>
        <span className="sl-caption sl-mono sl-truncate">{p.marketplace}</span>
      </span>
    ),
  },
  {
    key: "commit",
    header: "Commit",
    width: "14%",
    skeleton: 0.4,
    render: (p) => (
      <span className="sl-stack">
        <span className="sl-mono">{p.drift ? p.commits.map(shortCommit).join(", ") : shortCommit(p.commits[0] ?? p.nodes[0]?.commit)}</span>
        {p.drift && <Badge tone="warning">Nodes differ</Badge>}
      </span>
    ),
  },
  { key: "contents", header: "Contents", width: "22%", skeleton: 0.5, render: (p) => <span className="sl-caption">{contentsText(p)}</span> },
  {
    key: "servers",
    header: "Servers",
    skeleton: 0.6,
    render: (p) =>
      p.stdio.length + p.http.length === 0 ? (
        <span className="sl-caption sl-faint">No MCP servers</span>
      ) : (
        <span className="sl-stack">
          {p.http.map((s) => (
            <span key={s.name} className="sl-caption">
              <span className="sl-mono">{s.name}</span>
              {s.host ? <> ({s.host})</> : null}: {s.state}
              {s.warning ? <> <Badge tone="warning">{s.warning}</Badge></> : null}
            </span>
          ))}
          {p.stdio.map((s) => (
            <span key={s.name} className="sl-caption">
              <span className="sl-mono">{s.name}</span>: stdio
              {s.notMountedOn.length > 0 ? `, ${STDIO_NOT_MOUNTED} (${s.notMountedOn.join(", ")})` : ", in the node manifest"}
            </span>
          ))}
        </span>
      ),
  },
];

function LabelSection({ group }: { group: PluginLabelView }) {
  return (
    <section className="sl-section">
      <div className="sl-section__head">
        <div>
          <h2 className="sl-section__title sl-mono">{group.label}</h2>
          <p className="sl-caption">
            {group.nodes.map((n, i) => (
              <span key={n.instance}>
                {i > 0 ? ", " : ""}
                <span className="sl-mono">{n.instance}</span>{" "}
                {n.live ? "live" : <>offline, last report <TimeAgo at={n.reportedAt} /></>}
              </span>
            ))}
          </p>
        </div>
      </div>
      <Card>
        <Table label={`Plugins on ${group.label}`} columns={columns} rows={group.plugins} rowKey={(p) => p.key} empty={<EmptyState title="No plugins" description="These nodes reported no plugins." />} />
      </Card>
    </section>
  );
}

export function PluginsPage() {
  const { data, loading, error, reload } = useApi<PluginsResponse>("/api/plugins");
  return (
    <>
      <PageHeader title="Plugins" description="What each machine runs, by node label. Plugins are installed into the node image; nothing here changes them." />
      {error ? (
        <ErrorState what="plugins" error={error} onRetry={reload} />
      ) : loading || !data ? (
        <Skeleton />
      ) : !data.available ? (
        <EmptyState title="No nodes report plugins here" description="The plugin inventory lists plugins from nodes. This deployment runs agents in the gateway process." />
      ) : data.labels.length === 0 ? (
        <EmptyState title="No plugins reported" description="A node sends its plugin report when it starts. Bake plugins into the node image and roll the nodes." />
      ) : (
        data.labels.map((g) => <LabelSection key={g.label} group={g} />)
      )}
    </>
  );
}
