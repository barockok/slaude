/**
 * The soul and access settings that constrain an agent, each value with where
 * it comes from. Shown where each belongs (phase B moved them off the
 * Guardrails page): the agent's Access tab, the Memory page's Write rules and
 * the agent's Mandates tab.
 */
import type { ReactNode } from "react";
import type { AgentSettingsGroup, AgentSettingsResponse, SettingsFamily, SettingsSource, SettingsValue } from "../../../gateway/panel/api-types";
import { Link } from "../../lib/router";
import { Badge, Card, KeyValue, Markdown, Skeleton, type BadgeTone } from "../../ui";
import { useApi } from "../hooks/useApi";
import { slackToMarkdown } from "../lib/slack-markup";
import { ErrorState } from "./ErrorState";

const SOURCE: Record<SettingsSource, { label: string; tone: BadgeTone; hint: string }> = {
  env: { label: "Env", tone: "accent", hint: "Set by an environment variable on this deployment" },
  soul: { label: "Soul", tone: "success", hint: "Written in the agent's soul (SOUL.md)" },
  persona: { label: "Persona", tone: "success", hint: "Set in the persona's config (personas as code)" },
  console: { label: "Console", tone: "accent", hint: "A grant stored from the console" },
  learned: { label: "Learned", tone: "warning", hint: "Taught by a person in a conversation" },
  default: { label: "Default", tone: "neutral", hint: "Nothing sets it, so the default applies" },
  code: { label: "Fixed", tone: "neutral", hint: "Fixed in the code" },
};

export function SourceTag({ source, origin }: { source: SettingsSource; origin?: string }) {
  const s = SOURCE[source] ?? { label: source, tone: "neutral" as const, hint: "" };
  return (
    <span className="sl-gr-source" title={origin ? `${s.hint}: ${origin}` : s.hint}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

function renderValue(v: SettingsValue["value"]): ReactNode {
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

const STATUS: Record<SettingsFamily["status"], ReactNode> = {
  active: null,
  unavailable: <Badge tone="warning">Unavailable</Badge>,
  "not-implemented": <Badge>Not implemented</Badge>,
};

export function SettingsFamilyCard({ f }: { f: SettingsFamily }) {
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
      id={`settings-${f.id}`}
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
            <table className="sl-simple-table" aria-label={f.title}>
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

const GROUP_LABEL: Record<AgentSettingsGroup, string> = {
  access: "Access settings",
  memory: "Memory write rules",
  mandates: "Proactive settings",
  "learned-rules": "Learned rules",
};

/** One group of an agent's settings, fetched on its own (a slow group never holds up the page around it). */
export function AgentSettings({ agent, group }: { agent: string; group: AgentSettingsGroup }) {
  const { data, error, reload } = useApi<AgentSettingsResponse>(`/api/agents/${encodeURIComponent(agent)}/settings/${group}`);
  if (error && !data) {
    return (
      <Card>
        <ErrorState what={GROUP_LABEL[group]} error={error} onRetry={reload} />
      </Card>
    );
  }
  if (!data) return <Skeleton height="10rem" radius="var(--sl-radius-panel)" />;
  return (
    <div className="sl-stack-lg">
      {data.families.map((f) => (
        <SettingsFamilyCard key={f.id} f={f} />
      ))}
    </div>
  );
}
