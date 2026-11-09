import type { AgentDetailResponse } from "../../../../gateway/panel/api-types";
import { Link, navigate } from "../../../lib/router";
import { Avatar, Badge, Card, CodeBlock, IconArrowLeft, KeyValue, PageHeader, Skeleton, Tabs } from "../../../ui";
import { ErrorState } from "../../components/ErrorState";
import { LiveBadge } from "../../components/LiveBadge";
import { useApi } from "../../hooks/useApi";
import { AccessTab } from "./AccessTab";
import { ActivityTab } from "./ActivityTab";
import { GuardrailsTab } from "./GuardrailsTab";
import { MandatesTab } from "./MandatesTab";

export const AGENT_TABS = ["overview", "mandates", "access", "guardrails", "activity"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

const TAB_LABEL: Record<AgentTab, string> = { overview: "Overview", mandates: "Mandates", access: "Access", guardrails: "Guardrails", activity: "Activity" };

export const agentPath = (name: string, tab: AgentTab = "overview") =>
  `/agents/${encodeURIComponent(name)}${tab === "overview" ? "" : `/${tab}`}`;

export function isAgentTab(t: string | undefined): t is AgentTab {
  return !!t && (AGENT_TABS as readonly string[]).includes(t);
}

function IdentityCard({ agent }: { agent: AgentDetailResponse }) {
  return (
    <Card title="Identity">
      <KeyValue
        items={[
          { key: "name", label: "Name", value: agent.name },
          {
            key: "slack",
            label: "Slack user id",
            value: agent.slackUserId ? <span className="sl-mono">{agent.slackUserId}</span> : <span className="sl-faint">None (uses the shared app user)</span>,
          },
          { key: "model", label: "Model", value: agent.model ? <span className="sl-mono">{agent.model}</span> : <span className="sl-faint">Deployment default</span> },
          { key: "runsOn", label: "Runs on", value: <span className="sl-mono">{agent.runsOn}</span> },
          { key: "live", label: "Live", value: <LiveBadge live={agent.live} /> },
          { key: "mandates", label: "Mandates", value: agent.mandateCount },
          { key: "grants", label: "Console grants", value: agent.grantCount },
        ]}
      />
    </Card>
  );
}

function DefinitionCard({ agent }: { agent: AgentDetailResponse }) {
  return (
    <Card title="Definition">
      <p className="sl-caption">
        {agent.definition.source === "agent.yaml"
          ? "Read-only: edit this agent's agent.yaml and deploy to change it. Secret values are redacted."
          : "Read-only: this agent is defined by its SOUL.md. Shown in agent.yaml form, with secret values redacted."}
      </p>
      <CodeBlock code={agent.definition.yaml} language="yaml" className="sl-definition" />
    </Card>
  );
}

function HeaderSkeleton() {
  return (
    <div className="sl-detail-skeleton" aria-busy="true" aria-label="Loading agent">
      <Skeleton width="100%" height="2.5rem" />
      <Skeleton width="100%" height="12rem" radius="var(--sl-radius-panel)" />
    </div>
  );
}

export function AgentDetailPage({ name, tab }: { name: string; tab: AgentTab }) {
  const { data, error, reload } = useApi<AgentDetailResponse>(`/api/agents/${encodeURIComponent(name)}`);

  const back = (
    <Link to="/agents" className="sl-back">
      <IconArrowLeft size={14} />
      Agents
    </Link>
  );

  const title = (
    <span className="sl-title-row">
      <Avatar name={name} />
      <span>{name}</span>
      {data && <LiveBadge live={data.live} />}
      {name === "default" && <Badge tone="accent">Default</Badge>}
    </span>
  );

  return (
    <>
      <PageHeader
        back={back}
        title={title}
        description={data ? `Runs on ${data.runsOn}. ${data.mandateCount} ${data.mandateCount === 1 ? "mandate" : "mandates"}, ${data.grants.length} effective ${data.grants.length === 1 ? "grant" : "grants"}.` : undefined}
      />
      {error && !data ? (
        <Card>
          <ErrorState what="Agent" error={error} onRetry={reload} />
        </Card>
      ) : (
        <Tabs
          label="Agent sections"
          tabs={AGENT_TABS.map((t) => ({ value: t, label: TAB_LABEL[t] }))}
          value={tab}
          onChange={(t) => navigate(agentPath(name, t), { inPage: true })}
        >
          {!data ? (
            <HeaderSkeleton />
          ) : tab === "overview" ? (
            <div className="sl-stack-lg">
              <IdentityCard agent={data} />
              <DefinitionCard agent={data} />
            </div>
          ) : tab === "mandates" ? (
            <MandatesTab agent={data} />
          ) : tab === "access" ? (
            <AccessTab agent={data} onChanged={reload} />
          ) : tab === "guardrails" ? (
            <GuardrailsTab name={name} />
          ) : (
            <ActivityTab name={name} />
          )}
        </Tabs>
      )}
    </>
  );
}
