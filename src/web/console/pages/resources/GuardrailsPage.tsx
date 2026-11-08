import { useState, type ReactNode } from "react";
import type {
  AgentsResponse,
  GuardrailDetail,
  GuardrailEntry,
  GuardrailFamily,
  GuardrailKind,
  GuardrailSetting,
  GuardrailSource,
  GuardrailState,
  GuardrailToggle,
  GuardrailsResponse,
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

// --- The runtime layer: system prompt, hooks and gates, limits ---------------

const STATE: Record<GuardrailState, { label: string; tone: BadgeTone; hint: string }> = {
  enforcing: { label: "Enforcing", tone: "success", hint: "Installed and acting in this deployment" },
  shadow: { label: "Shadow", tone: "warning", hint: "Runs and logs, but does not change what happens" },
  off: { label: "Off", tone: "neutral", hint: "Turned off by its toggle" },
  "not-wired": { label: "Not wired", tone: "danger", hint: "The code exists, but this deployment does not install it" },
  "not-built": { label: "Not built", tone: "neutral", hint: "Designed, not implemented" },
};

export function StateChip({ state }: { state: GuardrailState }) {
  const s = STATE[state];
  return (
    <span title={s.hint} className="sl-gr-source">
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

function toggleText(t: GuardrailToggle): ReactNode {
  if (t.source === "none") return <span className="sl-faint">Always on</span>;
  const where = t.source === "env" ? "Env" : t.source === "thread" ? "Per thread" : "Soul";
  return (
    <span className="sl-break">
      {where}
      {t.key && (
        <>
          {": "}
          <span className="sl-mono">{t.key}</span>
        </>
      )}
      {t.default && <span className="sl-caption"> (default {t.default})</span>}
    </span>
  );
}

function detailValue(v: GuardrailDetail["value"]): ReactNode {
  return renderValue(v);
}

function Details({ items }: { items: GuardrailDetail[] }) {
  if (!items.length) return null;
  return (
    <KeyValue
      className="sl-kv--compact"
      items={items.map((d, i) => ({ key: `${i}-${d.label}`, label: d.label, value: detailValue(d.value) }))}
    />
  );
}

/** Details as short lines, for a table cell. */
function InlineDetails({ items }: { items: GuardrailDetail[] }) {
  if (!items.length) return null;
  return (
    <span className="sl-gr-inline-details">
      {items.map((d, i) => (
        <span key={`${i}-${d.label}`} className="sl-gr-value">
          <span className="sl-caption">{d.label}:</span>
          <span className="sl-gr-value__main">{detailValue(d.value)}</span>
        </span>
      ))}
    </span>
  );
}

function Fold({ summary, children, id }: { summary: ReactNode; children: ReactNode; id?: string }) {
  const [open, setOpen] = useState(false);
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

function SystemPrompt({ data }: { data: GuardrailsResponse }) {
  return (
    <Card
      id="guardrails-system-prompt"
      title="System prompt"
      description="What every session of this agent is told, in order. The runtime baseline is one render for every agent of this deployment; only the persona and channel mandates differ per agent."
    >
      <div className="sl-stack-lg">
        <ol className="sl-gr-layers" aria-label="System prompt layers">
          {data.promptStack.layers.map((l) => (
            <li key={l.id} className="sl-gr-layer" data-layer={l.id}>
              <span className="sl-title-row">
                <span className="sl-subhead">{l.title}</span>
                <Badge tone={l.overridable ? "success" : "neutral"}>{l.overridable ? "From the soul" : "Fixed by the runtime"}</Badge>
                {l.count !== undefined && <Badge>{`${l.count} ${l.count === 1 ? "channel" : "channels"}`}</Badge>}
                {!l.present && <span className="sl-caption">Not present for this agent</span>}
              </span>
              <span className="sl-caption sl-break">
                {l.source}
                {l.note ? `. ${l.note}` : ""}
              </span>
              {l.link && (
                <Link className="sl-link" to={l.link.to}>
                  {l.link.label}
                </Link>
              )}
            </li>
          ))}
        </ol>
        <p className="sl-notice">
          The soul is written to follow the baseline, but nothing in the code stops a soul from contradicting it. Read both together.
        </p>
        <h3 className="sl-subhead">Runtime baseline{data.baseline.brain ? "" : " (memory stores off)"}</h3>
        <div className="sl-gr-blocks" aria-label="Runtime baseline blocks">
          {data.baseline.blocks.map((b) => (
            <Fold key={b.id} id={`baseline-${b.id}`} summary={<span className="sl-break">{b.title.replace(/`/g, "")}</span>}>
              <Markdown source={b.markdown} copyLabel="Copy block" />
            </Fold>
          ))}
        </div>
        {data.builtinSkills.length > 0 && (
          <>
            <h3 className="sl-subhead">Built-in skills</h3>
            <KeyValue
              className="sl-kv--compact"
              items={data.builtinSkills.map((sk) => ({
                key: sk.qualified,
                label: <span className="sl-mono">{sk.qualified}</span>,
                value: (
                  <span className="sl-gr-value">
                    <span className="sl-gr-value__main">{sk.trigger}</span>
                    {sk.governs.length > 0 && (
                      <span className="sl-gr-value__note">
                        <span className="sl-caption">Governs, until loaded: </span>
                        {renderValue(sk.governs)}
                      </span>
                    )}
                  </span>
                ),
              }))}
            />
          </>
        )}
        <h3 className="sl-subhead">Added to single turns</h3>
        <KeyValue
          className="sl-kv--compact"
          items={data.promptStack.perTurn.map((p) => ({ key: p.id, label: p.title, value: <span className="sl-break">{p.summary}</span> }))}
        />
      </div>
    </Card>
  );
}

type KindFilter = "enforcement" | "hook" | "gate" | "observability" | "all";
const KIND_FILTER: FilterOption<KindFilter>[] = [
  { value: "enforcement", label: "Hooks and gates" },
  { value: "hook", label: "Hooks" },
  { value: "gate", label: "Gates" },
  { value: "observability", label: "Observability" },
  { value: "all", label: "All" },
];
const KIND_SETS: Record<KindFilter, GuardrailKind[]> = {
  enforcement: ["hook", "gate"],
  hook: ["hook"],
  gate: ["gate"],
  observability: ["observability"],
  all: ["hook", "gate", "observability"],
};
const APPLIES: Record<string, string> = {
  interactive: "Threads",
  wake: "Wakes",
  remote: "Remote",
  voice: "Voice",
  background: "Background",
  deployment: "Deployment",
};

const entries = (data: GuardrailsResponse, kinds: GuardrailKind[]) => data.guardrails.filter((g) => kinds.includes(g.kind)).flatMap((g) => g.entries);

function HooksAndGates({ data, kind, onKind }: { data: GuardrailsResponse; kind: KindFilter; onKind: (k: KindFilter) => void }) {
  const rows = entries(data, KIND_SETS[kind]);
  const columns: Column<GuardrailEntry>[] = [
    { key: "event", header: "Event", width: "9rem", render: (e) => (e.event ? <span className="sl-mono">{e.event}</span> : <span className="sl-faint">None</span>) },
    {
      key: "guardrail",
      header: "Guardrail",
      width: "22%",
      render: (e) => (
        <span className="sl-stack">
          <span className="sl-subhead">{e.title}</span>
          <span className="sl-caption sl-break">{e.summary}</span>
        </span>
      ),
    },
    {
      key: "effect",
      header: "What it does",
      render: (e) => (
        <span className="sl-stack">
          <span className="sl-break">{e.effect}</span>
          <InlineDetails items={e.details} />
          {e.fieldNote && (
            <a className="sl-link" href={e.fieldNote.href} target="_blank" rel="noopener noreferrer">
              Design: {e.fieldNote.title}
            </a>
          )}
          <span className="sl-caption sl-mono sl-break">{e.source}</span>
        </span>
      ),
    },
    { key: "applies", header: "Applies to", width: "10rem", render: (e) => <span className="sl-break">{e.appliesTo.map((a) => APPLIES[a] ?? a).join(", ")}</span> },
    { key: "state", header: "State", width: "8rem", render: (e) => <StateChip state={e.state} /> },
    { key: "toggle", header: "Toggle", width: "14rem", render: (e) => toggleText(e.toggle) },
  ];
  return (
    <Card
      id="guardrails-hooks"
      title="Hooks and gates"
      description="Code that blocks, rewrites or stops the agent: SDK hooks, the permission and wake gates, and the decision gate. Read from the runtime's registry, with each state for this deployment."
      actions={<FilterChip label="Kind" value={kind} options={KIND_FILTER} onChange={onKind} />}
    >
      <Table label="Hooks and gates" columns={columns} rows={rows} rowKey={(e) => e.id} className="sl-gr-hooks" />
    </Card>
  );
}

function LimitsAndDenyLists({ data }: { data: GuardrailsResponse }) {
  const rows = entries(data, ["deny-list", "limit", "redaction"]);
  return (
    <Card id="guardrails-limits" title="Limits and deny lists" description="Tools that are never offered, caps on unattended work, and what is masked before anything leaves.">
      <div className="sl-gr-limits">
        {rows.map((e) => (
          <section key={e.id} className="sl-gr-limit" id={`guardrail-${e.id}`} aria-label={e.title}>
            <span className="sl-title-row">
              <span className="sl-subhead">{e.title}</span>
              <StateChip state={e.state} />
              <Badge>{e.appliesTo.map((a) => APPLIES[a] ?? a).join(", ")}</Badge>
            </span>
            <p className="sl-caption sl-break">
              {e.summary} {e.effect}
            </p>
            <Details items={e.details} />
            <span className="sl-caption">
              {toggleText(e.toggle)}
              {" | "}
              <span className="sl-mono sl-break">{e.source}</span>
            </span>
          </section>
        ))}
      </div>
    </Card>
  );
}

export function GuardrailsPage() {
  const search = new URLSearchParams(useSearch());
  const agent = search.get("agent") || "default";
  const kindParam = search.get("kind") as KindFilter | null;
  const kind: KindFilter = kindParam && kindParam in KIND_SETS ? kindParam : "enforcement";
  const go = (a: string, k: KindFilter) =>
    navigate(`/guardrails?agent=${encodeURIComponent(a)}${k === "enforcement" ? "" : `&kind=${k}`}`, { replace: true });
  const agents = useApi<AgentsResponse>("/api/agents");
  const { data, error, reload } = useApi<GuardrailsResponse>(`/api/guardrails?agent=${encodeURIComponent(agent)}`);
  const names = agents.data?.agents.map((a) => a.name) ?? [agent];
  const options: FilterOption<string>[] = (names.includes(agent) ? names : [agent, ...names]).map((n) => ({ value: n, label: n }));

  return (
    <>
      <PageHeader
        title="Guardrails"
        description="The runtime's own layer under the soul: the fixed system prompt baseline, and the hooks and gates that block, rewrite or stop the agent. Then the soul and access settings that constrain each agent. Read-only."
      />
      <div className="sl-filter-row">
        <FilterChip label="Agent" value={agent} options={options} onChange={(v) => go(v, kind)} />
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
      ) : (
        <div className="sl-stack-lg">
          {data.promptStack && <SystemPrompt data={data} />}
          {data.guardrails && <HooksAndGates data={data} kind={kind} onKind={(k) => go(agent, k)} />}
          {data.guardrails && <LimitsAndDenyLists data={data} />}
          <h2 className="sl-section-title">Soul and access settings</h2>
          {data.families.length === 0 ? (
            <Card>
              <EmptyState title="No guardrails to show" />
            </Card>
          ) : (
            data.families.map((f) => <FamilyCard key={f.id} f={f} />)
          )}
        </div>
      )}
    </>
  );
}
