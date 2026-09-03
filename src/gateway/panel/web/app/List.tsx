import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "./types";
import { api } from "./api";
import { statusMeta, personaColor, personaInitial, summarize } from "./lib";
import { StatusDot, RelTime } from "./ui";

const REFRESH_MS = 3000;

export function SessionList({ onOpen }: { onOpen: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [persona, setPersona] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [beat, setBeat] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api().listSessions({ persona: persona || undefined, status: status || undefined });
        if (alive) { setSessions(s); setErr(null); setBeat((b) => b + 1); }
      } catch (e: any) { if (alive) setErr(e.message ?? "failed to load"); }
    };
    load();
    timer.current = window.setInterval(load, REFRESH_MS);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [persona, status]);

  const personas = useMemo(
    () => Array.from(new Set((sessions ?? []).map((s) => s.persona_id))).sort(),
    [sessions],
  );
  const stats = useMemo(() => summarize(sessions ?? []), [sessions]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (sessions ?? []).filter(
      (s) => !needle || s.title?.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle),
    );
  }, [sessions, q]);

  const statusOrder = ["running", "waiting", "error", "done", "idle"];

  return (
    <div className="wrap" data-view="list">
      <div className="page-head">
        <div>
          <h1 className="page-title">Fleet</h1>
          <div className="page-sub">Live sessions across every persona, node and channel.</div>
        </div>
        <div className="live" aria-live="polite">
          <span className="pulse" /> auto-refresh 3s · updated <RelTime ts={Date.now()} key={beat} />
        </div>
      </div>

      <div className="stats">
        <button className={`stat ${status === "" ? "active" : ""}`} onClick={() => setStatus("")}>
          <span className="bar" style={{ background: "var(--accent)" }} />
          <span><span className="num">{stats.total}</span><br /><span className="lbl">total</span></span>
        </button>
        {statusOrder.map((st) => {
          const n = stats.by[st] ?? 0;
          const m = statusMeta(st);
          return (
            <button key={st} className={`stat ${status === st ? "active" : ""}`} onClick={() => setStatus(status === st ? "" : st)}>
              <span className="bar" style={{ background: m.color }} />
              <span><span className="num" style={{ color: n ? m.color : "var(--text-mute)" }}>{n}</span><br /><span className="lbl">{m.label}</span></span>
            </button>
          );
        })}
        <button className="stat" onClick={() => setStatus("")}>
          <span className="bar" style={{ background: "var(--st-green)" }} />
          <span><span className="num" style={{ color: "var(--st-green)" }}>{stats.warm}</span><br /><span className="lbl">warm</span></span>
        </button>
      </div>

      <div className="filters">
        <div className="field">
          <select className="select" value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Filter persona">
            <option value="">All personas</option>
            {personas.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="field">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter status">
            <option value="">All statuses</option>
            {statusOrder.map((s) => <option key={s} value={s}>{statusMeta(s).label}</option>)}
          </select>
        </div>
        <input className="input search" placeholder="Search title or id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <span className="live">{shown.length} shown</span>
      </div>

      {err && <div className="notice-503" style={{ marginBottom: 12 }}>Could not reach the panel API: {err}</div>}

      <div className="tablewrap">
        <table className="fleet">
          <thead>
            <tr>
              <th className="row-accent" aria-hidden />
              <th>Status</th>
              <th>Session</th>
              <th>Persona</th>
              <th className="hide-sm">Model</th>
              <th>Host</th>
              <th className="hide-sm">Last active</th>
              <th className="th-ctx" title="Share of the context window used. Bar turns amber at ≥65%, red at ≥85% — ticks mark the cutoffs.">Context</th>
              <th>Control</th>
            </tr>
          </thead>
          <tbody>
            {sessions === null && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}><td className="row-accent"><i /></td>
                {Array.from({ length: 8 }).map((__, j) => <td key={j}><div className="sk" style={{ height: 12, width: j === 1 ? 180 : 80 }} /></td>)}
              </tr>
            ))}
            {shown.map((s) => {
              const m = statusMeta(s.status);
              return (
                <tr key={s.id} onClick={() => onOpen(s.id)} data-sid={s.id} data-status={s.status}>
                  <td className="row-accent"><i style={{ background: m.color }} /></td>
                  <td><StatusDot status={s.status} /></td>
                  <td>
                    <div className="sess-cell">
                      <span className="sess-title">{s.title ?? "Untitled session"}</span>
                      <span className="sess-id mono">{s.id}{s.engaged ? "" : " · disengaged"}</span>
                    </div>
                  </td>
                  <td>
                    <span className="persona">
                      <span className="av" style={{ background: personaColor(s.persona_id) }}>{personaInitial(s.persona_id)}</span>
                      {s.persona_id}
                    </span>
                  </td>
                  <td className="hide-sm"><span className="model-tag">{s.model}</span></td>
                  <td>
                    {s.warm
                      ? <span className="chip node" title={`warm on ${s.node}`}>{s.node}</span>
                      : <span className="chip cold"><span className="d" style={{ background: "var(--st-neutral)" }} />cold</span>}
                  </td>
                  <td className="hide-sm cell-dim"><RelTime ts={s.updated_at} /></td>
                  <td>
                    <div className="tok" title={`${Math.round((s.ctx_pct ?? 0) * 100)}% of context window`}>
                      <span className="meter"><i style={{ width: `${Math.round((s.ctx_pct ?? 0) * 100)}%`, background: ctxColor(s.ctx_pct ?? 0) }} /></span>
                      <span className="pct">{s.ctx_pct != null ? `${Math.round(s.ctx_pct * 100)}%` : "-"}</span>
                    </div>
                  </td>
                  <td>
                    {s.panel_locked_by
                      ? <span className="chip lock" title={`driven by ${s.panel_locked_by}`}>🔒 {s.panel_locked_by.split("@")[0]}</span>
                      : <span className="cell-mute">-</span>}
                  </td>
                </tr>
              );
            })}
            {sessions !== null && shown.length === 0 && (
              <tr><td colSpan={9}><div className="empty"><div className="big">No sessions match</div>Clear the filters to see the full fleet.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ctxColor(pct: number): string {
  if (pct >= 0.85) return "var(--st-red)";
  if (pct >= 0.65) return "var(--st-orange)";
  return "var(--accent)";
}
