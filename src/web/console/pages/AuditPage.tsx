import { useEffect, useMemo, useState } from "react";
import type { AgentsResponse, AuditEventView } from "../../../gateway/panel/api-types";
import { navigate, useSearch } from "../../lib/router";
import {
  Button, Card, EmptyState, FilterChip, IconClose, Input, PageHeader, SearchField, type FilterOption,
} from "../../ui";
import { AuditDrawer } from "../components/AuditDrawer";
import { AuditTable } from "../components/AuditTable";
import { ErrorState } from "../components/ErrorState";
import { useApi } from "../hooks/useApi";
import { useAuditPages } from "../hooks/useAuditPages";
import { actionLabel } from "../lib/format";

const PAGE = 50;
const HOUR = 3_600_000;

/** Action categories and the action prefix each one filters on. */
const CATEGORIES = [
  { value: "permission", label: "Permission", prefix: "gate.permission." },
  { value: "approval", label: "Approval", prefix: "gate.approval." },
  { value: "connect", label: "Connect", prefix: "gate.mcp_connect." },
  { value: "grants", label: "Grants", prefix: "grant." },
  { value: "proposals", label: "Proposals", prefix: "proposal." },
  { value: "memory", label: "Memory", prefix: "memory." },
  { value: "admin", label: "Admin", prefix: "panel." },
] as const;

const CATEGORY_OPTIONS: FilterOption<string>[] = [{ value: "all", label: "All" }, ...CATEGORIES.map((c) => ({ value: c.value, label: c.label }))];

const DECISION_OPTIONS: FilterOption<string>[] = [
  { value: "all", label: "Any" },
  { value: "allow", label: "Allow" },
  { value: "always", label: "Always" },
  { value: "deny", label: "Deny" },
  { value: "refused", label: "Refused" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

type Range = "all" | "24h" | "7d" | "30d" | "custom";
const RANGE_OPTIONS: FilterOption<Range>[] = [
  { value: "all", label: "Any time" },
  { value: "24h", label: "Last 24 h" },
  { value: "7d", label: "Last 7 d" },
  { value: "30d", label: "Last 30 d" },
  { value: "custom", label: "Custom" },
];
const RANGE_MS: Partial<Record<Range, number>> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

const isRange = (v: string | null): v is Range => !!v && RANGE_OPTIONS.some((o) => o.value === v);

/** epoch ms to the value a datetime-local input takes, in local time. */
function toLocalInput(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function AuditPage() {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const persona = params.get("persona") ?? "";
  const action = params.get("action") ?? "";
  const actor = params.get("actor") ?? "";
  const decision = params.get("decision") ?? "";
  const session = params.get("session") ?? "";
  const range: Range = isRange(params.get("range")) ? (params.get("range") as Range) : params.get("since") || params.get("until") ? "custom" : "all";
  const sinceParam = params.get("since");
  const untilParam = params.get("until");

  const [actorDraft, setActorDraft] = useState(actor);
  const [open, setOpen] = useState<AuditEventView | null>(null);
  // Relative ranges are pinned when chosen, so paging stays on one window.
  const [rangeAnchor, setRangeAnchor] = useState(() => Date.now());

  useEffect(() => setActorDraft(actor), [actor]);

  /** Write the filters back into the URL (replacing the entry, so Back leaves the page). */
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    navigate(q ? `/audit?${q}` : "/audit", { replace: true });
  };

  // Debounced: the server matches an actor id exactly, so query once typing stops.
  useEffect(() => {
    const v = actorDraft.trim();
    if (v === actor) return;
    const t = setTimeout(() => update({ actor: v || null }), 400);
    return () => clearTimeout(t);
  }, [actorDraft]);

  const category = CATEGORIES.find((c) => c.prefix === action)?.value ?? "all";
  const exactAction = action && category === "all" ? action : "";

  const since = range === "custom" ? (sinceParam ? Number(sinceParam) : null) : RANGE_MS[range] ? rangeAnchor - RANGE_MS[range]! : null;
  const until = range === "custom" && untilParam ? Number(untilParam) : null;

  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (persona) q.set("persona", persona);
    if (action) q.set("action", action);
    if (actor) q.set("actor", actor);
    if (decision) q.set("decision", decision);
    if (session) q.set("session", session);
    if (since != null && Number.isFinite(since)) q.set("since", String(since));
    if (until != null && Number.isFinite(until)) q.set("until", String(until));
    q.set("limit", String(PAGE));
    return `/api/audit?${q}`;
  }, [persona, action, actor, decision, session, since, until]);

  const pages = useAuditPages(url);
  const agents = useApi<AgentsResponse>("/api/agents");
  const agentOptions: FilterOption<string>[] = [
    { value: "all", label: "All" },
    ...(agents.data?.agents ?? []).map((a) => ({ value: a.name, label: a.name })),
  ];
  if (persona && !agentOptions.some((o) => o.value === persona)) agentOptions.push({ value: persona, label: persona });

  const filtered = !!(persona || action || actor || decision || session || range !== "all");
  const clearAll = () => {
    setActorDraft("");
    navigate("/audit", { replace: true });
  };

  return (
    <>
      <PageHeader title="Approvals and audit" description="Every permission decision and console change, newest first." />
      <div className="sl-filter-row sl-filter-row--wrap">
        <FilterChip label="Agent" value={persona || "all"} options={agentOptions} onChange={(v) => update({ persona: v === "all" ? null : v })} />
        <FilterChip
          label="Action"
          value={category}
          options={CATEGORY_OPTIONS}
          onChange={(v) => update({ action: CATEGORIES.find((c) => c.value === v)?.prefix ?? null })}
        />
        <FilterChip label="Decision" value={decision || "all"} options={DECISION_OPTIONS} onChange={(v) => update({ decision: v === "all" ? null : v })} />
        <FilterChip
          label="Time"
          value={range}
          options={RANGE_OPTIONS}
          onChange={(v) => {
            setRangeAnchor(Date.now());
            if (v === "custom") update({ range: "custom", since: String(Date.now() - 24 * HOUR), until: null });
            else update({ range: v === "all" ? null : v, since: null, until: null });
          }}
        />
        <SearchField
          label="Filter by actor"
          placeholder="Actor id or email"
          value={actorDraft}
          onChange={(e) => setActorDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") update({ actor: actorDraft.trim() || null });
          }}
        />
      </div>

      {(range === "custom" || exactAction || session) && (
        <div className="sl-filter-row sl-filter-row--wrap sl-filter-row--sub">
          {range === "custom" && (
            <div className="sl-range">
              <label className="sl-range__field">
                <span className="sl-caption">From</span>
                <Input
                  type="datetime-local"
                  size="sm"
                  value={toLocalInput(since)}
                  onChange={(e) => update({ since: e.target.value ? String(new Date(e.target.value).getTime()) : null })}
                />
              </label>
              <label className="sl-range__field">
                <span className="sl-caption">To</span>
                <Input
                  type="datetime-local"
                  size="sm"
                  value={toLocalInput(until)}
                  onChange={(e) => update({ until: e.target.value ? String(new Date(e.target.value).getTime()) : null })}
                />
              </label>
            </div>
          )}
          {exactAction && (
            <ActiveFilter label="Action" value={actionLabel(exactAction)} onClear={() => update({ action: null })} />
          )}
          {session && <ActiveFilter label="Session" value={session} mono onClear={() => update({ session: null })} />}
        </div>
      )}

      {pages.error && pages.items.length === 0 ? (
        <Card>
          <ErrorState what="Audit events" error={pages.error} onRetry={pages.reload} />
        </Card>
      ) : (
        <div className="sl-section sl-section--flush">
          <AuditTable
            label="Audit events"
            rows={pages.items}
            loading={pages.loading}
            skeletonRows={10}
            showAgent
            onRowClick={setOpen}
            empty={
              filtered ? (
                <EmptyState
                  title="No matching events"
                  description="Nothing in the audit trail matches these filters."
                  action={<Button onClick={clearAll}>Clear filters</Button>}
                />
              ) : (
                <EmptyState
                  title="No audit events yet"
                  description="Permission decisions, approvals, grant changes and console actions are recorded here as they happen."
                />
              )
            }
          />
          {pages.error && pages.items.length > 0 && (
            <p className="sl-form__error" role="alert">
              Could not load more: {pages.error.message}
            </p>
          )}
          {pages.hasMore && !pages.loading && (
            <div className="sl-more">
              <Button onClick={pages.loadMore} loading={pages.more}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      <AuditDrawer event={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** A filter that came in through a link and has no chip of its own. */
function ActiveFilter({ label, value, mono, onClear }: { label: string; value: string; mono?: boolean; onClear: () => void }) {
  return (
    <span className="sl-active-filter">
      <span className="sl-chip__label">{label}</span>
      <span className={mono ? "sl-mono" : undefined}>{value}</span>
      <button type="button" className="sl-active-filter__clear" aria-label={`Remove the ${label.toLowerCase()} filter`} onClick={onClear}>
        <IconClose size={14} />
      </button>
    </span>
  );
}
