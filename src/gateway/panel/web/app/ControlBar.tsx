import { useState } from "react";
import { api, ApiError, FORCE_503 } from "./api";
import { PERMISSION_MODES, MODELS } from "./lib";
import { Modal } from "./ui";

type Pending = null | { action: "stop" | "reset"; title: string; body: string; confirm: string; danger?: boolean };

export function ControlBar({ session, onChanged }: { session: any; onChanged: (s: any) => void }) {
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [noRedis, setNoRedis] = useState(FORCE_503);
  const [flash, setFlash] = useState<string | null>(null);
  // Superadmin-gated actions stay rendered but inert: an operator should be able
  // to see the control exists and why it is closed to them. Presentation only —
  // the server re-checks the role on every request.
  const isSuper = api().role === "superadmin";
  const superOnly = (label: string) => (isSuper ? undefined : `${label} requires the superadmin role`);

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await api().control(session.id, body);
      onChanged(r.session);
      setFlash(`${body.action} applied`);
      setTimeout(() => setFlash(null), 1800);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setNoRedis(true);
      else setFlash(`failed: ${(e as Error).message}`);
    } finally { setBusy(false); setPending(null); setReason(""); }
  }

  return (
    <div className="controlbar" data-testid="controlbar">
      {/* Destructive interventions, fenced off in their own danger-tinted group
          so a reset/stop can never be mistaken for a benign config change. */}
      <div className="ctl-grp danger" data-testid="grp-intervene">
        <span className="grp-label">Intervene</span>
        <button
          className="btn danger" data-testid="btn-stop" disabled={busy || noRedis}
          title={noRedis ? "Stop needs the Redis event bus, which this deploy is running without." : "Ask the agent to halt the current turn"}
          onClick={() => setPending({ action: "stop", title: "Request stop", body: "This asks the agent to halt its current turn at the next safe point. Work already written to disk is kept. A reason is recorded in the audit log.", confirm: "Request stop", danger: true })}
        >⏹ Request stop</button>
        <button
          className="btn danger" data-testid="btn-reset" disabled={busy || !isSuper}
          title={superOnly("Reset") ?? "Destructive: kills the running Claude process for this thread on the next message"}
          onClick={() => setPending({ action: "reset", title: "Reset session", body: "This clears the started flag so the next message boots a fresh Claude process for this thread. Transcript history is preserved. This is audited.", confirm: "Reset session", danger: true })}
        >↺ Reset</button>
      </div>

      <span className="sep" />

      <div className="ctl-grp">
        <span className="grp-label">Config</span>
        <select className="select" data-testid="sel-model" defaultValue={session.model} disabled={busy}
          onChange={(e) => run({ action: "model", model: e.target.value })} aria-label="Model">
          {[...new Set([session.model, ...MODELS])].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className="select" data-testid="sel-mode" defaultValue={session.permission_mode ?? "default"}
          disabled={busy || !isSuper} title={superOnly("Changing the permission mode")}
          onChange={(e) => run({ action: "mode", mode: e.target.value })} aria-label="Permission mode">
          {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {session.slack_thread_ts && (
        <>
          <span className="sep" />
          <div className="ctl-grp">
            <span className="grp-label">Engagement</span>
            <button className="btn" data-testid="btn-unlock" disabled={busy} onClick={() => run({ action: "unlock-1on1" })}
              title="Release the per-thread engagement lock so the whole channel can talk to the agent again">
              🔓 Unlock 1:1
            </button>
          </div>
        </>
      )}

      {noRedis && <span className="notice-503" data-testid="notice-503">Stop is disabled: this deploy runs without the Redis event bus.</span>}
      {flash && <span className="live" data-testid="control-flash">{flash}</span>}

      {pending && (
        <Modal title={pending.title} onClose={() => setPending(null)}>
          <p>{pending.body}</p>
          <label htmlFor="reason">Reason (recorded)</label>
          <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you doing this?" />
          <div className="row">
            <button className="btn ghost" onClick={() => setPending(null)}>Cancel</button>
            <button className={`btn ${pending.danger ? "danger" : "primary"}`} data-testid="confirm-action"
              disabled={busy || reason.trim().length === 0}
              onClick={() => run({ action: pending.action })}>
              {pending.confirm}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
