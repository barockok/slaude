import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Avatar, Badge, Button, CodeBlock, EmptyState, IconChevronDown, IconChevronRight, IconLock, cx } from "../../../ui";
import type { StreamEntry, StreamStatus } from "../../lib/sessionStream";
import type { SessionHistory } from "./useSessionHistory";
import { resultText, type Delivery, type Item } from "./timeline-model";
import { ACTOR_KIND_LABEL, absoluteTime, actionLabel, clockTime, decisionLabel, decisionTone, duration } from "../../lib/format";

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

/** The record keeps a turn's time; shown as a date and time, not a clock. */
function EarlierTime({ at }: { at: number }) {
  return (
    <time className="sl-tl__time" dateTime={new Date(at).toISOString()} title={absoluteTime(at)}>
      {absoluteTime(at)}
    </time>
  );
}

const DELIVERY: Record<Delivery, { label: string; tone: "neutral" | "accent" | "warning" | "danger" | "success"; hint: string }> = {
  sending: { label: "Sending", tone: "neutral", hint: "The reply tool has not answered yet" },
  slack: { label: "Sent to Slack", tone: "success", hint: "Posted in the thread" },
  held: { label: "Held in console", tone: "warning", hint: "An operator holds this session, so the reply stayed here and Slack never saw it" },
  failed: { label: "Not sent", tone: "danger", hint: "The tool refused or failed; nobody in Slack saw this" },
};

/** Where an agent message went. */
export function DeliveryMark({ delivery, target }: { delivery: Delivery; target?: string }) {
  const d = DELIVERY[delivery];
  return (
    <span title={d.hint} className="sl-tl__delivery">
      <Badge tone={d.tone}>{delivery === "slack" && target ? `Sent to ${target}` : d.label}</Badge>
    </span>
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
        <div className={cx("sl-tl__msg", it.who === "operator" && "is-operator", it.who === "user" && "is-user")}>
          <Avatar name={it.name} size="sm" />
          <div className="sl-tl__msg-body">
            <div className="sl-tl__meta">
              <span className="sl-tl__who">{it.who === "operator" ? `${it.name} (console)` : it.name}</span>
              {it.who === "user" && <span className="sl-caption">in Slack</span>}
              {it.delivery && <DeliveryMark delivery={it.delivery} target={it.target} />}
              {it.earlier ? <EarlierTime at={it.at} /> : <Time at={it.at} />}
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

/** Earlier turns above the live ones: "Load earlier", the divider, and why there are none when there are none. */
export function EarlierHeader({ history, count }: { history: SessionHistory; count: number }) {
  if (history.loading) return <p className="sl-caption sl-tl__earlier-note" aria-busy="true">Loading earlier turns</p>;
  if (count === 0) {
    const why = history.error ? `Earlier turns could not be loaded: ${history.error}` : history.note ? `No earlier turns to show: ${history.note}.` : null;
    return why ? <p className="sl-caption sl-tl__earlier-note">{why}</p> : null;
  }
  return (
    <>
      {history.hasMore && (
        <div className="sl-more">
          <Button size="sm" onClick={history.loadMore} loading={history.more}>
            Load earlier
          </Button>
        </div>
      )}
      {!history.hasMore && history.note && <p className="sl-caption sl-tl__earlier-note">{history.note[0]!.toUpperCase() + history.note.slice(1)}.</p>}
      <div className="sl-tl__divider is-earlier" role="separator">
        <span>Earlier in this session</span>
      </div>
    </>
  );
}

/**
 * Keeps a scroller at the bottom while the reader follows it, counts what
 * arrived while they scrolled up, and holds the view still when older lines
 * are added above.
 */
export function useFollow(liveCount: number, earlierCount: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastLive = useRef(liveCount);
  const lastEarlier = useRef(earlierCount);
  const heightBefore = useRef(0);
  heightBefore.current = scroller.current?.scrollHeight ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    const addedLive = liveCount - lastLive.current;
    const addedEarlier = earlierCount - lastEarlier.current;
    const firstEarlier = lastEarlier.current === 0;
    lastLive.current = liveCount;
    lastEarlier.current = earlierCount;
    if (!el) return;
    if (addedEarlier > 0 && !firstEarlier && !following) {
      // Older lines went in above: keep what the reader is looking at in place.
      el.scrollTop += el.scrollHeight - heightBefore.current;
      return;
    }
    if (addedLive <= 0 && addedEarlier <= 0) return;
    if (following) el.scrollTop = el.scrollHeight;
    else if (addedLive > 0) setUnseen((n) => n + addedLive);
  }, [liveCount, earlierCount, following]);

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

  return { scroller, following, unseen, onScroll, jump };
}

export function TimelineTab({
  items, earlier, history, status, detail,
}: { items: Item[]; earlier: Item[]; history: SessionHistory; status: StreamStatus; detail: string | null }) {
  const { scroller, following, unseen, onScroll, jump } = useFollow(items.length, earlier.length);
  const empty = items.length === 0 && earlier.length === 0;

  return (
    <div className="sl-tl">
      {(status === "reconnecting" || status === "unavailable" || status === "signed-out") && (
        <p className={cx("sl-notice", status === "signed-out" ? "is-danger" : "is-warning")} role="status">
          {status === "reconnecting" ? "The live tail dropped. Reconnecting; nothing is lost while it catches up." : detail}
        </p>
      )}
      <div className="sl-tl__scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Session timeline">
        <EarlierHeader history={history} count={earlier.length} />
        {earlier.length > 0 && (
          <ol className="sl-tl__list" aria-label="Earlier in this session">
            {earlier.map((it) => (
              <li key={it.key}>
                <ItemView it={it} />
              </li>
            ))}
          </ol>
        )}
        {earlier.length > 0 && items.length > 0 && (
          <div className="sl-tl__divider" role="separator">
            <span>Since you opened this page</span>
          </div>
        )}
        {empty ? (
          <EmptyState
            title={status === "unavailable" ? "No live tail on this deployment" : "Waiting for activity"}
            description={
              status === "unavailable"
                ? "Without an event bus the console cannot follow a session live. Tool permission decisions still appear here from the audit trail."
                : "Messages, tool calls and decisions appear here as the agent works."
            }
          />
        ) : (
          <>
            {items.length > 0 && (
              <ol className="sl-tl__list">
                {items.map((it) => (
                  <li key={it.key}>
                    <ItemView it={it} />
                  </li>
                ))}
              </ol>
            )}
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
      {!following && !empty && (
        <button type="button" className="sl-jump-pill" onClick={jump}>
          <IconChevronDown size={14} />
          Jump to latest{unseen > 0 ? ` (${unseen} new)` : ""}
        </button>
      )}
    </div>
  );
}

export type { Item as TimelineItem };
