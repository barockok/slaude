import type { ReactNode } from "react";
import type { AgentsResponse, GuardrailFamily, GuardrailSetting, GuardrailSource, GuardrailsResponse } from "../../../../gateway/panel/api-types";
import { Link, navigate, useSearch } from "../../../lib/router";
import { Badge, Card, EmptyState, FilterChip, KeyValue, Markdown, PageHeader, Skeleton, type BadgeTone, type FilterOption } from "../../../ui";
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

export function GuardrailsPage() {
  const agent = new URLSearchParams(useSearch()).get("agent") || "default";
  const agents = useApi<AgentsResponse>("/api/agents");
  const { data, error, reload } = useApi<GuardrailsResponse>(`/api/guardrails?agent=${encodeURIComponent(agent)}`);
  const names = agents.data?.agents.map((a) => a.name) ?? [agent];
  const options: FilterOption<string>[] = (names.includes(agent) ? names : [agent, ...names]).map((n) => ({ value: n, label: n }));

  return (
    <>
      <PageHeader
        title="Guardrails"
        description="What constrains each agent today: the effective value of every guardrail and where it comes from. Read-only; change them in the soul, the environment or on the Access tab."
      />
      <div className="sl-filter-row">
        <FilterChip label="Agent" value={agent} options={options} onChange={(v) => navigate(`/guardrails?agent=${encodeURIComponent(v)}`, { replace: true })} />
      </div>
      {error && !data ? (
        <Card>
          <ErrorState what="Guardrails" error={error} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div className="sl-stack-lg" aria-busy="true" aria-label="Loading guardrails">
          <Skeleton height="12rem" radius="var(--sl-radius-panel)" />
          <Skeleton height="12rem" radius="var(--sl-radius-panel)" />
        </div>
      ) : data.families.length === 0 ? (
        <Card>
          <EmptyState title="No guardrails to show" />
        </Card>
      ) : (
        <div className="sl-stack-lg">
          {data.families.map((f) => (
            <FamilyCard key={f.id} f={f} />
          ))}
        </div>
      )}
    </>
  );
}
