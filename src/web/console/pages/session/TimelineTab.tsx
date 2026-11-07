import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuditEventView, SessionUsageSnapshot } from "../../../../gateway/panel/api-types";
import { Avatar, Badge, CodeBlock, EmptyState, IconChevronDown, IconChevronRight, IconLock, cx } from "../../../ui";
import type { StreamEntry, StreamStatus } from "../../lib/sessionStream";
import { ACTOR_KIND_LABEL, absoluteTime, actionLabel, clockTime, decisionLabel, decisionTone, duration } from "../../lib/format";

export interface OperatorMessage {
  id: string;
  at: number;
  text: string;
  by: string;
}

type Item =
  | { kind: "turn"; key: string; at: number }
  | { kind: "done"; key: string; at: number; ms: number | null }
  | { kind: "text"; key: string; at: number; who: "agent" | "operator"; name: string; text: string }
  | { kind: "thinking"; key: string; at: number; text: string }
  | { kind: "tool"; key: string; at: number; tool: string; input: unknown; result?: unknown; resultAt?: number; isError?: boolean }
  | { kind: "result"; key: string; at: number; tool: string; result: unknown; isError: boolean }
  | { kind: "error"; key: string; at: number; message: string; code?: string }
  | { kind: "compacting"; key: string; at: number; trigger: string }
  | { kind: "gate"; key: string; at: number; event: AuditEventView };

const isErrorResult = (r: unknown) => !!r && typeof r === "object" && (r as { is_error?: unknown }).is_error === true;

/** The text worth showing of a tool result: its output string when it has one, JSON otherwise. */
export function resultText(r: unknown): string {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    for (const k of ["stdout", "content", "output", "text"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
    if (Array.isArray(o.content)) {
      const parts = o.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).filter(Boolean);
      if (parts.length) return parts.join("\n");
    }
  }
  return JSON.stringify(r, null, 2) ?? "";
}

/** One line that says what a tool call does: the command, the file, the pattern. */
function inputSummary(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof o[k] === "string" && o[k]) return (o[k] as string).split("\n")[0]!;
  }
  return "";
}

export function buildItems(entries: StreamEntry[], gates: AuditEventView[], sent: OperatorMessage[], persona: string): Item[] {
  const out: Item[] = [];
  const open = new Map<string, number[]>(); // tool name -> indexes of calls awaiting a result
  let turnAt: number | null = null;
  for (const { id, at, event: e } of entries) {
    if ("autoEvolve" in e && e.autoEvolve) continue; // the background skill check is not part of the conversation
    switch (e.type) {
      case "turnStart":
        turnAt = at;
        out.push({ kind: "turn", key: id, at });
        break;
      case "done":
        out.push({ kind: "done", key: id, at, ms: turnAt == null ? null : at - turnAt });
        turnAt = null;
        break;
      case "assistantText":
        if (e.text.trim()) out.push({ kind: "text", key: id, at, who: "agent", name: persona, text: e.text });
        break;
      case "thinking":
        if (e.text.trim()) out.push({ kind: "thinking", key: id, at, text: e.text });
        break;
      case "toolCall":
        (open.get(e.tool) ?? open.set(e.tool, []).get(e.tool)!).push(out.length);
        out.push({ kind: "tool", key: id, at, tool: e.tool, input: e.input });
        break;
      case "toolResult": {
        const i = open.get(e.tool)?.shift();
        const call = i === undefined ? null : out[i];
        if (call && call.kind === "tool") {
          out[i!] = { ...call, result: e.result, resultAt: at, isError: isErrorResult(e.result) };
        } else {
          out.push({ kind: "result", key: id, at, tool: e.tool, result: e.result, isError: isErrorResult(e.result) });
        }
        break;
      }
      case "error":
        out.push({ kind: "error", key: id, at, message: e.error, code: e.code });
        turnAt = null;
        break;
      case "compacting":
        out.push({ kind: "compacting", key: id, at, trigger: e.trigger });
        break;
      case "tokenUsage":
        break;
    }
  }
  for (const g of gates) out.push({ kind: "gate", key: `gate-${g.id}`, at: g.at, event: g });
  for (const m of sent) out.push({ kind: "text", key: m.id, at: m.at, who: "operator", name: m.by, text: m.text });
  // Stable: stream items keep their order; gates and operator messages slot in by time.
  return out.map((it, i) => [it, i] as const).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([it]) => it);
}

export function latestUsage(entries: StreamEntry[]): SessionUsageSnapshot | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "tokenUsage") return e.snapshot;
  }
  return null;
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  unavailable: "No live tail",
  "signed-out": "Disconnected",
};

export function StreamIndicator({ status }: { status: StreamStatus }) {
  return (
    <span className={cx("sl-live", `is-${status}`)} role="status">
      <span className="sl-live__dot" aria-hidden="true" />
      {STATUS_TEXT[status]}
    </span>
  );
}

function Time({ at }: { at: number }) {
  return (
    <time className="sl-tl__time" dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
      {clockTime(at)}
    </time>
  );
}

function Fold({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={cx("sl-fold", className)} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="sl-fold__summary">
        {open ? <IconChevronDown size={14} className="sl-fold__chev" /> : <IconChevronRight size={14} className="sl-fold__chev" />}
        {summary}
      </summary>
      {open && <div className="sl-fold__body">{children}</div>}
    </details>
  );
}

function ItemView({ it }: { it: Item }) {
  switch (it.kind) {
    case "turn":
      return (
        <div className="sl-tl__divider">
          <span>Turn started</span>
          <Time at={it.at} />
        </div>
      );
    case "done":
      return (
        <div className="sl-tl__divider is-end">
          <span>Turn finished{it.ms != null ? ` in ${duration(it.ms)}` : ""}</span>
        </div>
      );
    case "compacting":
      return (
        <div className="sl-tl__divider">
          <span>Compacting context ({it.trigger === "auto" ? "automatic" : "requested"})</span>
          <Time at={it.at} />
        </div>
      );
    case "text":
      return (
        <div className={cx("sl-tl__msg", it.who === "operator" && "is-operator")}>
          <Avatar name={it.name} size="sm" />
          <div className="sl-tl__msg-body">
            <div className="sl-tl__meta">
              <span className="sl-tl__who">{it.who === "operator" ? `${it.name} (console)` : it.name}</span>
              <Time at={it.at} />
            </div>
            <p className="sl-tl__text">{it.text}</p>
          </div>
        </div>
      );
    case "thinking":
      return (
        <div className="sl-tl__row">
          <Fold
            className="sl-tl__thinking"
            summary={
              <>
                <span className="sl-tl__label">Thinking</span>
                <span className="sl-caption sl-truncate">{it.text.split("\n")[0]}</span>
              </>
            }
          >
            <p className="sl-tl__text sl-tl__text--muted">{it.text}</p>
          </Fold>
        </div>
      );
    case "tool": {
      const done = it.result !== undefined;
      return (
        <div className={cx("sl-tl__tool", it.isError && "is-error")}>
          <Fold
            summary={
              <>
                <span className="sl-tl__tool-name">{it.tool}</span>
                <span className="sl-mono sl-caption sl-truncate sl-tl__tool-arg">{inputSummary(it.input)}</span>
                <span className="sl-tl__tool-state">
                  {!done ? (
                    <Badge tone="accent">Running</Badge>
                  ) : it.isError ? (
                    <Badge tone="danger">Error</Badge>
                  ) : (
                    <span className="sl-caption sl-nowrap">{duration((it.resultAt ?? it.at) - it.at)}</span>
                  )}
                </span>
              </>
            }
          >
            <div className="sl-stack-lg">
              <CodeBlock language="input" code={typeof it.input === "string" ? it.input : JSON.stringify(it.input, null, 2)} className="sl-code--wrap sl-code--short" />
              {done ? (
                <CodeBlock language={it.isError ? "error" : "result"} code={resultText(it.result)} className="sl-code--wrap sl-code--short" />
              ) : (
                <p className="sl-caption">Waiting for the result.</p>
              )}
            </div>
          </Fold>
        </div>
      );
    }
    case "result":
      return (
        <div className={cx("sl-tl__tool", it.isError && "is-error")}>
          <Fold
            summary={
              <>
                <span className="sl-tl__tool-name">{it.tool}</span>
                <span className="sl-caption sl-truncate sl-tl__tool-arg">Result (its call happened before this page opened)</span>
              </>
            }
          >
            <CodeBlock language="result" code={resultText(it.result)} className="sl-code--wrap sl-code--short" />
          </Fold>
        </div>
      );
    case "error":
      return (
        <div className="sl-tl__error" role="note">
          <div className="sl-tl__meta">
            <span className="sl-tl__who">The turn failed{it.code ? ` (${it.code})` : ""}</span>
            <Time at={it.at} />
          </div>
          <p className="sl-tl__text">{it.message}</p>
        </div>
      );
    case "gate": {
      const g = it.event;
      return (
        <div className="sl-tl__gate">
          <span className="sl-tl__gate-icon" aria-hidden="true">
            <IconLock size={14} />
          </span>
          <div className="sl-stack">
            <span className="sl-inline">
              <span className="sl-tl__who">{actionLabel(g.action)}</span>
              {g.decision && <Badge tone={decisionTone(g.decision)}>{decisionLabel(g.decision)}</Badge>}
            </span>
            <span className="sl-caption">
              {g.summary}
              {g.summary ? ". " : ""}
              {ACTOR_KIND_LABEL[g.actorKind] ?? g.actorKind} <span className="sl-mono">{g.actorId}</span>
            </span>
          </div>
          <Time at={g.at} />
        </div>
      );
    }
  }
}

export function TimelineTab({
  items, status, detail,
}: { items: Item[]; status: StreamStatus; detail: string | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(items.length);

  useLayoutEffect(() => {
    const added = items.length - lastCount.current;
    lastCount.current = items.length;
    const el = scroller.current;
    if (!el || added <= 0) return;
    if (following) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + added);
  }, [items.length, following]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setFollowing(atBottom);
    if (atBottom) setUnseen(0);
  };

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setFollowing(true);
    setUnseen(0);
  };

  return (
    <div className="sl-tl">
      {(status === "reconnecting" || status === "unavailable" || status === "signed-out") && (
        <p className={cx("sl-notice", status === "signed-out" ? "is-danger" : "is-warning")} role="status">
          {status === "reconnecting" ? "The live tail dropped. Reconnecting; nothing is lost while it catches up." : detail}
        </p>
      )}
      <div className="sl-tl__scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Session timeline">
        {items.length === 0 ? (
          <EmptyState
            title={status === "unavailable" ? "No live tail on this deployment" : "Waiting for activity"}
            description={
              status === "unavailable"
                ? "Without an event bus the console cannot follow a session live. Tool permission decisions still appear here from the audit trail."
                : "Messages, tool calls and decisions appear here as the agent works. Earlier turns are not replayed."
            }
          />
        ) : (
          <>
            <ol className="sl-tl__list">
              {items.map((it) => (
                <li key={it.key}>
                  <ItemView it={it} />
                </li>
              ))}
            </ol>
            {status === "live" && (
              <p className="sl-tl__listening">
                <span className="sl-live is-live" aria-hidden="true">
                  <span className="sl-live__dot" />
                </span>
                Listening for new activity
              </p>
            )}
          </>
        )}
      </div>
      {!following && items.length > 0 && (
        <button type="button" className="sl-jump-pill" onClick={jump}>
          <IconChevronDown size={14} />
          Jump to latest{unseen > 0 ? ` (${unseen} new)` : ""}
        </button>
      )}
    </div>
  );
}

export type { Item as TimelineItem };
