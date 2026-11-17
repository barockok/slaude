import type { OwnerGuardrailSummary, OwnerGuardrailsResponse } from "../../../../gateway/panel/api-types";
import { navigate } from "../../../lib/router";
import { Button, Card, EmptyState, IconPlus, PageHeader, Table, type Column } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { AppliesTo, GuardrailSourceBadges, GuardrailStatus, RuleCounts, ThreatModelNote, guardrailPath } from "./guardrailParts";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";

const COLUMNS: Column<OwnerGuardrailSummary>[] = [
  {
    key: "guardrail",
    header: "Guardrail",
    width: "26%",
    skeleton: 0.7,
    render: (g) => (
      <span className="sl-stack">
        <span className="sl-truncate sl-strong">{g.name}</span>
        <span className="sl-caption sl-truncate" title={g.description}>
          {g.description || <span className="sl-faint">No description</span>}
        </span>
      </span>
    ),
  },
  { key: "applies", header: "Applies to", width: "20%", skeleton: 0.5, render: (g) => <AppliesTo g={g} /> },
  { key: "rules", header: "Rules", width: "20%", skeleton: 0.5, render: (g) => <RuleCounts g={g} /> },
  { key: "source", header: "Source", width: "14%", skeleton: 0.4, render: (g) => <GuardrailSourceBadges g={g} /> },
  { key: "status", header: "Status", width: "12%", skeleton: 0.4, render: (g) => <GuardrailStatus g={g} /> },
  {
    key: "fired",
    header: "Last fired",
    width: "8rem",
    skeleton: 0.4,
    render: (g) => (g.lastFiredAt ? <TimeAgo at={g.lastFiredAt} /> : <span className="sl-faint">Never</span>),
  },
];

export function GuardrailsPage() {
  const { data, loading, error, reload } = useApi<OwnerGuardrailsResponse>("/api/guardrails");
  const canEdit = data?.canEdit ?? false;

  return (
    <>
      <PageHeader
        title="Guardrails"
        description="The rules you set for your agents, shared by every agent or for some, like their souls. Enforced rules are checked by code and never put in the prompt; Guidance is advisory text the agent reads."
        actions={
          <>
            <Button onClick={() => navigate("/guardrails/test")}>Test a guardrail</Button>
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              disabled={!canEdit}
              title={canEdit ? undefined : "Only a superadmin can create a guardrail"}
              onClick={() => navigate("/guardrails/new")}
            >
              New guardrail
            </Button>
          </>
        }
      />
      {error && !data ? (
        <Card>
          <ErrorState what="Guardrails" error={error} onRetry={reload} />
        </Card>
      ) : (
        <div className="sl-stack-lg">
          {data?.failure && (
            <p className="sl-notice is-danger" role="alert">
              The stored guardrails could not be verified, so no agent session starts and no guardrail can be changed until they are fixed: {data.failure}. The owner repairs the set on the host with slaude guardrails import --repair.
            </p>
          )}
          {data && <ThreatModelNote t={data.threatModel} />}
          <Table
            label="Guardrails"
            columns={COLUMNS}
            rows={data?.guardrails ?? []}
            rowKey={(g) => g.slug}
            loading={loading && !data}
            skeletonRows={4}
            onRowClick={(g) => navigate(guardrailPath(g.slug))}
            className="sl-gr-table"
            empty={
              <EmptyState
                title="No guardrails yet"
                description="Create one here from a template, add a guardrails/<name>/GUARDRAIL.md folder to the deploy repo, or import host files with slaude guardrails import <dir>."
              />
            }
          />
        </div>
      )}
    </>
  );
}
