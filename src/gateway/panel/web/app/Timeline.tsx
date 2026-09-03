import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEntry, AgentEvent } from "./types";
import { clockTime, exactTime } from "./lib";

// Event lane vocabulary. This is the second big win over Temporal: typed,
// colored nodes on a continuous spine with real tool-call duration bars, not a
// bare uniform ruler.
const LANE: Record<AgentEvent["type"], { label: string; color: string }> = {
  assistantText: { label: "Reply", color: "var(--accent)" },
  toolCall: { label: "Tool call", color: "var(--st-blue)" },
  toolResult: { label: "Tool result", color: "var(--st-green)" },
  thinking: { label: "Thinking", color: "var(--st-neutral)" },
  turnStart: { label: "Turn", color: "var(--text-mute)" },
  done: { label: "Done", color: "var(--st-green)" },
  error: { label: "Error", color: "var(--st-red)" },
  tokenUsage: { label: "Context", color: "var(--st-orange)" },
  compacting: { label: "Compacting", color: "var(--st-orange)" },
};

function summarizeInput(tool: string, input: any): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (input.command) return String(input.command);
  if (input.file_path) return input.old_string ? `${input.file_path}\n- ${input.old_string}\n+ ${input.new_string}` : String(input.file_path);
  return JSON.stringify(input, null, 2);
}
const isErr = (r: any) => /(\berror\b|exception|traceback|\bfailed\b)/i.test(String(r)) && !/0 fail/i.test(String(r));

interface Node extends TimelineEntry { durationMs?: number; resultErr?: boolean }

export function Timeline({ entries, live }: { entries: TimelineEntry[]; live: boolean }) {
  const [autoscroll, setAutoscroll] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  // pair toolCall -> toolResult (FIFO per tool) to attach durations
  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = entries.map((e) => ({ ...e }));
    const pending: Record<string, number[]> = {};
    out.forEach((n, i) => {
      if (n.event.type === "toolCall") (pending[n.event.tool] ??= []).push(i);
      else if (n.event.type === "toolResult") {
        const q = pending[n.event.tool];
        const ci = q?.shift();
        if (ci != null) out[ci]!.durationMs = n.ts - out[ci]!.ts;
        (n as Node).resultErr = isErr(n.event.result);
      }
    });
    return out;
  }, [entries]);

  useEffect(() => {
    if (autoscroll && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [nodes.length, autoscroll]);

  const laneKeys: AgentEvent["type"][] = ["assistantText", "toolCall", "toolResult", "thinking", "error"];

  return (
    <div className="card" data-view="timeline">
      <div className="tl-head">
        <div className="legend">
          {laneKeys.map((k) => <span key={k}><i style={{ background: LANE[k].color }} />{LANE[k].label}</span>)}
        </div>
        <div className="tl-live">
          <span className="chip node mono" data-testid="event-count">{nodes.length} events</span>
          <button className="btn sm ghost" onClick={() => setAutoscroll((a) => !a)} data-testid="autoscroll-toggle">
            {autoscroll ? "⏸ pause scroll" : "▶ follow"}
          </button>
          <span className="status running" title={live ? "streaming" : "idle"}>
            <span className="dot" style={{ background: live ? "var(--st-green)" : "var(--st-neutral)", "--halo": "var(--st-green-bg)" } as any} />
          </span>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="empty"><div className="big">Waiting for the live tail</div>Events stream here as the agent works this session.</div>
      ) : (
        <div className="tl-scroll" ref={scroller} data-testid="timeline-scroll">
          <div className="timeline">
            {(() => {
              const t0 = nodes[0]!.ts;
              return nodes.map((n, idx) => {
                const prev = idx > 0 ? nodes[idx - 1]! : null;
                const gapMs = prev ? n.ts - prev.ts : 0;
                const showGap = !!prev && gapMs > 0 && n.event.type !== "turnStart" && prev.event.type !== "turnStart";
                return (
                  <Fragment key={n.id}>
                    {showGap && <TimelineGap ms={gapMs} />}
                    <TimelineNode node={n} offsetMs={n.ts - t0} />
                  </Fragment>
                );
              });
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// A proportional, dotted spine segment between two events. Its height scales
// with the elapsed gap so idle time reads at a glance; notable gaps carry a
// mono label (the query wait, the test run).
function TimelineGap({ ms }: { ms: number }) {
  const h = Math.round(Math.min(72, Math.max(6, ms * 0.02)));
  return (
    <div className="tl-gap" data-testid="tl-gap" style={{ height: h }}>
      <span className="tl-gap-line" />
      {ms >= 700 && <span className="tl-gap-lbl">{fmtDur(ms)}</span>}
    </div>
  );
}

function TimelineNode({ node, offsetMs }: { node: Node; offsetMs: number }) {
  const ev = node.event;
  const lane = LANE[ev.type];

  if (ev.type === "turnStart") {
    return <div className="tl-node" data-ev="turnStart"><div className="tl-turn"><span className="ln" />turn started {clockTime(node.ts)}<span className="ln" /></div></div>;
  }

  const color = ev.type === "toolResult" && node.resultErr ? "var(--st-red)" : lane.color;
  const thinking = ev.type === "thinking";

  return (
    <div className={`tl-node ${thinking ? "tl-thinking" : ""}`} data-ev={ev.type} data-testid="tl-node">
      <div className="tl-time" title={`${exactTime(node.ts)} · clock ${clockTime(node.ts)}`}>{fmtOffset(offsetMs)}</div>
      <div className="tl-spine"><span className="tl-dot" style={{ background: color }} /></div>
      <div className="tl-body">
        <div className="tl-card">
          <div className="hd">
            <span className="tl-type" style={{ color }}>{node.resultErr ? "Tool failed" : lane.label}</span>
            {"tool" in ev && <span className="tl-tool">{(ev as any).tool}</span>}
            {node.durationMs != null && <span className="tl-dur">{fmtDur(node.durationMs)}</span>}
          </div>
          {renderContent(node)}
          {ev.type === "toolCall" && node.durationMs != null && (
            <div className="tl-durbar"><i style={{ width: `${Math.min(100, (node.durationMs / 1500) * 100)}%`, background: color }} /></div>
          )}
        </div>
      </div>
    </div>
  );
}

function renderContent(node: Node) {
  const ev = node.event;
  switch (ev.type) {
    case "assistantText": return <div className="tl-content">{ev.text}</div>;
    case "thinking": return <div className="tl-content">{ev.text}</div>;
    case "toolCall": { const s = summarizeInput(ev.tool, ev.input); return s ? <div className="tl-content code">{s}</div> : null; }
    case "toolResult": return <div className="tl-content code">{typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result, null, 2)}</div>;
    case "error": return <div className="tl-content" style={{ color: "var(--st-red)" }}>{ev.error}</div>;
    case "done": return <div className="tl-content">Turn complete.</div>;
    case "tokenUsage": {
      const s = ev.snapshot;
      return (
        <div className="tl-content">
          <div className="tok" style={{ maxWidth: 260 }}>
            <span className="meter"><i style={{ width: `${Math.round(s.pctUsed * 100)}%`, background: "var(--st-orange)" }} /></span>
            <span className="pct">{Math.round(s.pctUsed * 100)}%</span>
          </div>
          <span className="mono" style={{ fontSize: 11 }}>{s.totalInput.toLocaleString()} / {s.contextWindow.toLocaleString()} ctx · {s.outputTokens.toLocaleString()} out</span>
        </div>
      );
    }
    case "compacting": return <div className="tl-content">Compacting context ({ev.trigger}).</div>;
    default: return null;
  }
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// Relative offset since the first event in the tail: the primary, causally
// legible time reading (the absolute clock/timestamp stays on hover).
function fmtOffset(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `+${s.toFixed(1)}s`;
  return `+${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
