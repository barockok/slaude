import { useState, type ReactNode } from "react";
import type {
  AgentsResponse,
  GuardrailFamily,
  GuardrailSetting,
  GuardrailSettingsResponse,
  GuardrailSource,
  OwnerGuardrailSummary,
  OwnerGuardrailsResponse,
} from "../../../../gateway/panel/api-types";
import { Link, navigate, useSearch } from "../../../lib/router";
import {
  Badge,
  Card,
  EmptyState,
  FilterChip,
  IconChevronDown,
  IconChevronRight,
  KeyValue,
  Markdown,
  PageHeader,
  Skeleton,
  Table,
  type BadgeTone,
  type Column,
  type FilterOption,
} from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { AppliesTo, GuardrailSourceBadges, GuardrailStatus, RuleCounts, ThreatModelNote, guardrailPath } from "./guardrailParts";
import { ErrorState } from "../../components/ErrorState";
import { slackToMarkdown } from "../../lib/slack-markup";
import { useApi } from "../../hooks/useApi";

const SOURCE: Record<GuardrailSource, { label: string; tone: BadgeTone; hint: string }> = {
  env: { label: "Env", tone: "accent", hint: "Set by an environment variable on this deployment" },
  soul: { label: "Soul", tone: "success", hint: "Written in the agent's soul (SOUL.md)" },
  persona: { label: "Persona", tone: "success", hint: "Set in the persona's config (personas as code)" },
  console: { label: "Console", tone: "accent", hint: "A grant stored from the console" },
  learned: { label: "Learned", tone: "warning", hint: "Taught by a person in a conversation" },
  default: { label: "Default", tone: "neutral", hint: "Nothing sets it, so the default applies" },
  code: { label: "Fixed", tone: "neutral", hint: "Fixed in the code" },
};

export function SourceTag({ source, origin }: { source: GuardrailSource; origin?: string }) {
  const s = SOURCE[source] ?? { label: source, tone: "neutral" as const, hint: "" };
  return (
    <span className="sl-gr-source" title={origin ? `${s.hint}: ${origin}` : s.hint}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

function renderValue(v: GuardrailSetting["value"]): ReactNode {
  if (v === null || v === undefined) return <span className="sl-faint">Not set</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return <span className="sl-mono">{v.toLocaleString()}</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="sl-faint">None</span>;
    return (
      <ul className="sl-chips">
        {v.map((x) => (
          <li key={x} className="sl-tag sl-mono">
            {x}
          </li>
        ))}
      </ul>
    );
  }
  return <span className="sl-break">{v}</span>;
}

const STATUS: Record<GuardrailFamily["status"], ReactNode> = {
  active: null,
  unavailable: <Badge tone="warning">Unavailable</Badge>,
  "not-implemented": <Badge>Not implemented</Badge>,
};

function FamilyCard({ f }: { f: GuardrailFamily }) {
  return (
    <Card
      className="sl-gr-card"
      title={
        <span className="sl-title-row">
          <span>{f.title}</span>
          {STATUS[f.status]}
          <Badge>{f.scope === "agent" ? "This agent" : "Every agent"}</Badge>
        </span>
      }
      description={f.summary}
      id={`guardrail-${f.id}`}
    >
      <div className="sl-stack">
        {f.note && <p className="sl-notice is-warning">{f.note}</p>}
        {f.settings.length > 0 && (
          <KeyValue
            className="sl-kv--compact"
            items={f.settings.map((s) => ({
              key: s.key,
              label: s.label,
              value: (
                <span className="sl-gr-value">
                  <span className="sl-gr-value__main">{renderValue(s.value)}</span>
                  <SourceTag source={s.source} origin={s.origin} />
                  {s.note && <span className="sl-caption sl-gr-value__note">{s.note}</span>}
                </span>
              ),
            }))}
          />
        )}
        {f.table && f.table.rows.length > 0 && (
          <div className="sl-md__table-wrap" tabIndex={0}>
            <table className="sl-simple-table">
              <thead>
                <tr>
                  {f.table.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {f.table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, k) => (
                      <td key={k} className="sl-break">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {f.text && <Markdown source={slackToMarkdown(f.text)} title={f.textSource ? <span className="sl-caption">From {f.textSource}</span> : undefined} />}
        {f.link && (
          <Link className="sl-link" to={f.link.to}>
            {f.link.label}
          </Link>
        )}
      </div>
    </Card>
  );
}

function Fold({ summary, children, id, defaultOpen = false }: { summary: ReactNode; children: ReactNode; id?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="sl-fold" id={id} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="sl-fold__summary">
        {open ? <IconChevronDown size={14} className="sl-fold__chev" /> : <IconChevronRight size={14} className="sl-fold__chev" />}
        {summary}
      </summary>
      {open && <div className="sl-fold__body">{children}</div>}
    </details>
  );
}


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

/** The soul and access settings, until they move to the agent's own tabs. */
function SoulAndAccess({ agent, onAgent }: { agent: string; onAgent: (a: string) => void }) {
  const agents = useApi<AgentsResponse>("/api/agents");
  const { data, error, reload } = useApi<GuardrailSettingsResponse>(`/api/guardrails/settings?agent=${encodeURIComponent(agent)}`);
  const names = agents.data?.agents.map((a) => a.name) ?? [agent];
  const options: FilterOption<string>[] = (names.includes(agent) ? names : [agent, ...names]).map((n) => ({ value: n, label: n }));
  return (
    <div className="sl-stack-lg">
      <div className="sl-filter-row">
        <FilterChip label="Agent" value={agent} options={options} onChange={onAgent} />
      </div>
      {error && !data ? (
        <Card>
          <ErrorState what="Soul and access settings" error={error} onRetry={reload} />
        </Card>
      ) : !data ? (
        <Skeleton height="12rem" radius="var(--sl-radius-panel)" />
      ) : data.families.length === 0 ? (
        <Card>
          <EmptyState title="No settings to show" />
        </Card>
      ) : (
        data.families.map((f) => <FamilyCard key={f.id} f={f} />)
      )}
    </div>
  );
}

export function GuardrailsPage() {
  const search = new URLSearchParams(useSearch());
  const agent = search.get("agent") || "default";
  const { data, loading, error, reload } = useApi<OwnerGuardrailsResponse>("/api/guardrails");

  return (
    <>
      <PageHeader
        title="Guardrails"
        description="The rules you set for your agents, shared by every agent or for some, like their souls. Enforced rules are checked by code and never put in the prompt; Guidance is advisory text the agent reads."
      />
      {error && !data ? (
        <Card>
          <ErrorState what="Guardrails" error={error} onRetry={reload} />
        </Card>
      ) : (
        <div className="sl-stack-lg">
          {data?.failure && (
            <p className="sl-notice is-danger" role="alert">
              The stored guardrails could not be verified, so no agent session starts until they are fixed: {data.failure}
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
                description="Add a guardrails/<name>/GUARDRAIL.md folder to the deploy repo, or import host files with slaude guardrails import <dir>."
              />
            }
          />
          <Fold id="guardrails-soul-access" defaultOpen={search.has("agent")} summary={<span className="sl-subhead">Soul and access settings</span>}>
            <SoulAndAccess agent={agent} onAgent={(a) => navigate(`/guardrails?agent=${encodeURIComponent(a)}`, { replace: true })} />
          </Fold>
        </div>
      )}
    </>
  );
}
