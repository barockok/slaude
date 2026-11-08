import type { AgentGuardrailsResponse } from "../../../../gateway/panel/api-types";
import { Link, navigate } from "../../../lib/router";
import { Badge, Card, EmptyState, Table, type Column } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { channelText, GuardrailStatus, RuleCounts, guardrailPath } from "../resources/guardrailParts";

type Row = AgentGuardrailsResponse["guardrails"][number];

const COLUMNS: Column<Row>[] = [
  {
    key: "guardrail",
    header: "Guardrail",
    width: "32%",
    skeleton: 0.7,
    render: (g) => (
      <span className="sl-stack">
        <Link to={guardrailPath(g.slug)} className="sl-strong">
          {g.name}
        </Link>
        <span className="sl-caption sl-truncate" title={g.description}>
          {g.description || <span className="sl-faint">No description</span>}
        </span>
      </span>
    ),
  },
  {
    key: "via",
    header: "Applies as",
    width: "18%",
    skeleton: 0.4,
    render: (g) => (
      <span className="sl-stack">
        <Badge>{g.via === "shared" ? "Shared" : "This agent"}</Badge>
        {g.channelLimited && <span className="sl-caption">{`Only in ${g.channels.map(channelText).join(", ")}`}</span>}
      </span>
    ),
  },
  { key: "rules", header: "Rules", width: "24%", skeleton: 0.5, render: (g) => <RuleCounts g={g} /> },
  { key: "status", header: "Status", width: "14%", skeleton: 0.4, render: (g) => <GuardrailStatus g={g} /> },
  { key: "fired", header: "Last fired", width: "8rem", skeleton: 0.4, render: (g) => (g.lastFiredAt ? <TimeAgo at={g.lastFiredAt} /> : <span className="sl-faint">Never</span>) },
];

/** The owner guardrails that apply to one agent: shared and its own. */
export function GuardrailsTab({ name }: { name: string }) {
  const { data, loading, error, reload } = useApi<AgentGuardrailsResponse>(`/api/agents/${encodeURIComponent(name)}/guardrails`);
  if (error && !data) {
    return (
      <Card>
        <ErrorState what="Guardrails" error={error} onRetry={reload} />
      </Card>
    );
  }
  return (
    <div className="sl-stack-lg">
      {data?.failure && (
        <p className="sl-notice is-danger" role="alert">
          The stored guardrails could not be verified, so this agent's sessions do not start: {data.failure}
        </p>
      )}
      {data && (
        <p className="sl-caption">
          {`Always-loaded Guidance: ${data.prose.chars.toLocaleString()} of ${data.prose.max.toLocaleString()} characters.`}
          {data.prose.skipped.length > 0 && ` Left out because it did not fit: ${data.prose.skipped.map((s) => `${s.name} (${s.chars.toLocaleString()})`).join(", ")}.`}
        </p>
      )}
      <Table
        label="Guardrails of this agent"
        columns={COLUMNS}
        rows={data?.guardrails ?? []}
        rowKey={(g) => g.slug}
        loading={loading && !data}
        skeletonRows={3}
        onRowClick={(g) => navigate(guardrailPath(g.slug))}
        className="sl-gr-table"
        empty={<EmptyState title="No guardrails apply to this agent" description="Shared guardrails apply to every agent; others name the agents they apply to." />}
      />
    </div>
  );
}
