import { useEffect, useRef, useState } from "react";
import type { TimelineEntry } from "./types";
import { api, ApiError } from "./api";
import { statusMeta, personaColor, personaInitial, exactTime, relTime } from "./lib";
import { StatusDot, Copy, RelTime, Modal } from "./ui";
import { Timeline } from "./Timeline";
import { ControlBar } from "./ControlBar";
import { Chat } from "./Chat";

type Tab = "timeline" | "chat" | "advanced";

export function SessionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [session, setSession] = useState<any | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [tab, setTab] = useState<Tab>("timeline");
  const [live, setLive] = useState(false);
  const [confirmSteal, setConfirmSteal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const me = api().operator;

  useEffect(() => {
    let alive = true;
    api().getSession(id).then((r) => { if (alive) { setSession(r.session); setOwner(r.panel_locked_by ?? null); } })
      .catch((e) => alive && setErr(e.message));
    seen.current = new Set();
    setEntries([]);
    const stop = api().subscribe(id, (e) => {
      if (seen.current.has(e.id)) return;
      seen.current.add(e.id);
      setLive(true);
      setEntries((prev) => [...prev, e].slice(-400));
    });
    return () => { alive = false; stop(); };
  }, [id]);

  if (err) return <div className="wrap"><div className="empty"><div className="big">Could not load session</div>{err}<div style={{ marginTop: 14 }}><button className="btn" onClick={onBack}>Back to fleet</button></div></div></div>;
  if (!session) return <div className="wrap"><div className="ident"><div className="sk" style={{ height: 22, width: 260, marginBottom: 12 }} /><div className="sk" style={{ height: 12, width: 180 }} /></div></div>;

  const m = statusMeta(session.status);
  const hasControl = owner === me;

  async function release() { await api().release(id); setOwner(null); }
  async function steal() { const r = await api().forceRelease(id); setOwner(me); setConfirmSteal(false); void r; }

  const evCount = { chat: entries.filter((e) => e.event.type === "assistantText").length, timeline: entries.length };

  return (
    <div className="wrap" data-view="detail" data-sid={id}>
      <div className="crumb"><a onClick={onBack}>Fleet</a><span>/</span><span className="mono">{id}</span></div>

      <div className="ident" style={{ borderLeft: `3px solid ${m.color}` }}>
        <div className="ident-top">
          <StatusDot status={session.status} withLabel={false} />
          <span className="ident-title">{session.title ?? "Untitled session"}</span>
          <span className="chip" style={{ background: m.bg, color: m.color }}>{m.label}</span>
          <span className="persona"><span className="av" style={{ background: personaColor(session.persona_id) }}>{personaInitial(session.persona_id)}</span>{session.persona_id}</span>
          <span className="model-tag">{session.model}</span>
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 8, flexWrap: "wrap" }}>
          <Copy text={id} label={`id ${id}`} />
          {session.slack_channel_id && <Copy text={session.slack_channel_id} label={`channel ${session.slack_channel_id}`} />}
          {session.slack_thread_ts && <Copy text={session.slack_thread_ts} label={`thread ${session.slack_thread_ts}`} />}
        </div>

        <div className="meta-grid">
          <Meta k="Working dir" v={session.working_dir} mono />
          <Meta k="Host node" v={session.warm ? session.node : "cold (not warm on any node)"} mono={session.warm} />
          <Meta k="Engaged" v={session.engaged ? "yes" : "no"} />
          <Meta k="Claude started" v={session.claude_started ? "yes" : "no"} />
          <Meta k="Slack team" v={session.slack_team_id ?? "-"} mono />
          {session.tenant_id && <Meta k="Tenant" v={session.tenant_id} mono />}
          <Meta k="Created" v={`${relTime(session.created_at)}`} title={exactTime(session.created_at)} />
          <Meta k="Updated" v={`${relTime(session.updated_at)}`} title={exactTime(session.updated_at)} />
        </div>
      </div>

      {owner && (
        <div className={`lockbanner ${hasControl ? "mine" : "theirs"}`} data-testid="lock-banner">
          <span className="msg">
            {hasControl
              ? <>You hold this session. Slack outbound is paused and inbound deferred while you drive.</>
              : <>This session is driven by <b className="who">{owner}</b> via the panel. Slack is paused for them.</>}
          </span>
          {hasControl
            ? <button className="btn sm" data-testid="release" onClick={release}>Release control</button>
            : <button className="btn sm danger" data-testid="take-control-banner" onClick={() => setConfirmSteal(true)}>Take control</button>}
        </div>
      )}

      <ControlBar session={session} onChanged={setSession} />

      <div className="tabs" role="tablist">
        <div className="tabgrp">
          <span className="gl">Live</span>
          <button className={`tab ${tab === "timeline" ? "on" : ""}`} data-testid="tab-timeline" onClick={() => setTab("timeline")}>Timeline<span className="badge">{evCount.timeline}</span></button>
          <button className={`tab ${tab === "chat" ? "on" : ""}`} data-testid="tab-chat" onClick={() => setTab("chat")}>Chat<span className="badge">{evCount.chat}</span></button>
        </div>
        <div className="tabgrp">
          <span className="gl">Depth</span>
          <button className={`tab ${tab === "advanced" ? "on" : ""}`} data-testid="tab-advanced" onClick={() => setTab("advanced")}>Raw state</button>
        </div>
      </div>

      {tab === "timeline" && <Timeline entries={entries} live={live} />}
      {tab === "chat" && <Chat sessionId={id} entries={entries} hasControl={hasControl} onLockChange={setOwner} />}
      {tab === "advanced" && (
        <div className="card"><pre className="tl-content code" style={{ maxHeight: 460, margin: 0 }}>{JSON.stringify(session, null, 2)}</pre></div>
      )}

      {confirmSteal && (
        <Modal title="Take control from another operator" onClose={() => setConfirmSteal(false)}>
          <p>This force-releases the active-surface lock currently held by <b>{owner}</b> and hands it to you. They are displaced immediately. This action is audited.</p>
          <div className="row">
            <button className="btn ghost" onClick={() => setConfirmSteal(false)}>Cancel</button>
            <button className="btn danger" data-testid="confirm-steal" onClick={steal}>Force take control</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Meta({ k, v, mono, title }: { k: string; v: string; mono?: boolean; title?: string }) {
  return <div className="meta-item"><div className="k">{k}</div><div className={`v ${mono ? "mono" : ""}`} title={title}>{v}</div></div>;
}
