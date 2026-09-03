import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEntry } from "./types";
import { api, ApiError } from "./api";

// Chat surface. Take-control acquires the active-surface lock; sent text goes to
// /chat; the agent's replies arrive on the shared SSE tail (assistantText).
// Release resumes Slack. A 409 surfaces the current owner.
export function Chat({
  sessionId, entries, hasControl, onLockChange,
}: {
  sessionId: string;
  entries: TimelineEntry[];
  hasControl: boolean;
  onLockChange: (owner: string | null) => void;
}) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ ts: number; text: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  const replies = useMemo(
    () => entries.filter((e) => e.event.type === "assistantText" || e.event.type === "toolCall"),
    [entries],
  );

  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [replies.length, sent.length]);

  async function send() {
    const t = text.trim();
    if (!t) return;
    setBusy(true); setErr(null);
    try {
      await api().chat(sessionId, t);
      setSent((s) => [...s, { ts: Date.now(), text: t }]);
      setText("");
      onLockChange(api().operator);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr(`Session is driven by ${e.body?.owner ?? "another operator"}. Take control to send.`);
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function takeControl() {
    setErr(null);
    try { const r = await api().lock(sessionId); onLockChange(r.locked_by); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr(`Held by ${e.body?.owner ?? "another operator"}.`);
      else setErr((e as Error).message);
    }
  }

  // interleave agent stream + operator sends in time order
  const merged = useMemo(() => {
    const a = replies.map((e) => ({ ts: e.ts, kind: e.event.type === "toolCall" ? "tool" as const : "agent" as const, text: e.event.type === "toolCall" ? `${(e.event as any).tool}` : (e.event as any).text }));
    const o = sent.map((s) => ({ ts: s.ts, kind: "op" as const, text: s.text }));
    return [...a, ...o].sort((x, y) => x.ts - y.ts);
  }, [replies, sent]);

  return (
    <div className="card chat" data-testid="chat">
      <div className="chat-log" ref={log} data-testid="chat-log">
        {merged.length === 0 && <div className="chat-locked">No messages yet. The live agent stream will appear here.</div>}
        {merged.map((m, i) => (
          m.kind === "tool"
            ? <div key={i} className="msg tool">⚙ {m.text}</div>
            : <div key={i} className={`msg ${m.kind}`}><div className="who">{m.kind === "op" ? "you" : "agent"}</div>{m.text}</div>
        ))}
      </div>

      {hasControl ? (
        <div>
          <div className="composer">
            <textarea data-testid="chat-input" value={text} placeholder="Message this session as the operator…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
            <button className="btn primary" data-testid="chat-send" disabled={busy || !text.trim()} onClick={send}>Send</button>
          </div>
          {err && <div className="err-inline" data-testid="chat-error">{err}</div>}
          <div className="page-sub" style={{ marginTop: 6 }}>You hold this session. Slack replies are paused until you release. ⌘/Ctrl+Enter sends.</div>
        </div>
      ) : (
        <div>
          <div className="chat-locked" data-testid="chat-takeover">
            Take control to drive this session. While you hold it, Slack posting is suppressed and inbound is deferred.
            <div style={{ marginTop: 12 }}><button className="btn primary" data-testid="take-control" onClick={takeControl}>Take control</button></div>
          </div>
          {err && <div className="err-inline" data-testid="chat-error">{err}</div>}
        </div>
      )}
    </div>
  );
}
