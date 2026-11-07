import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { SessionChatResponse } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Avatar, Button, Dialog, EmptyState, IconLock, cx } from "../../../ui";
import { api } from "../../client";
import { absoluteTime, clockTime } from "../../lib/format";
import type { TimelineItem } from "./TimelineTab";
import type { SessionLock } from "./useSessionLock";

type ChatItem = Extract<TimelineItem, { kind: "text" }>;

export interface ChatTabProps {
  sessionId: string;
  /** Agent replies and operator messages, oldest first. */
  messages: ChatItem[];
  lock: SessionLock;
  isSuperadmin: boolean;
  onSent: (text: string) => void;
  /** No event bus (the live tail answered 503): the lock lives on the same Redis, so there is none either. */
  noBackend?: boolean;
}

function Banner({ tone, title, children, actions }: { tone: "neutral" | "accent" | "warning" | "danger"; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx("sl-banner", `is-${tone}`)} role="status">
      <span className="sl-banner__icon" aria-hidden="true">
        <IconLock size={16} />
      </span>
      <div className="sl-banner__text">
        <p className="sl-banner__title">{title}</p>
        {children && <p className="sl-banner__desc">{children}</p>}
      </div>
      {actions && <div className="sl-banner__actions">{actions}</div>}
    </div>
  );
}

export function ChatTab({ sessionId, messages, lock, isSuperadmin, onSent, noBackend }: ChatTabProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.length]);

  const unsupported = lock.unsupported || !!noBackend;
  const canType = lock.mine || unsupported;
  const someoneElse = !!lock.owner && !lock.mine;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.post<SessionChatResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, { text: t });
      onSent(t);
      setText("");
      if (!unsupported) lock.claimed();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const owner = (err.body as { owner?: string } | null)?.owner ?? null;
        lock.heldBy(owner);
        setSendError(owner ? `Not sent: ${owner} is driving this session now.` : "Not sent: someone else is driving this session now.");
      } else if (err instanceof ApiError && err.status === 503) {
        setSendError("Not sent: the console cannot reach the agent right now. Try again in a moment.");
      } else {
        setSendError(`Not sent: ${(err as Error).message}`);
      }
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const takeover = async () => {
    if (await lock.forceTake()) setConfirmTakeover(false);
  };

  return (
    <div className="sl-chat">
      <div className="sl-chat__log" ref={log} tabIndex={0} aria-label="Conversation" aria-live="polite">
        {messages.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description="Replies from the agent and messages you send from here show up in this conversation."
          />
        ) : (
          <ol className="sl-chat__list">
            {messages.map((m) => (
              <li key={m.key} className={cx("sl-chat__msg", m.who === "operator" && "is-operator")}>
                {m.who === "agent" && <Avatar name={m.name} size="sm" />}
                <div className="sl-chat__bubble">
                  <p className="sl-tl__text">{m.text}</p>
                  <time className="sl-chat__time" dateTime={new Date(m.at).toISOString()} title={absoluteTime(m.at)}>
                    {m.who === "operator" ? `${m.name}, ` : ""}
                    {clockTime(m.at)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="sl-chat__control">
        {lock.lost && !lock.owner && (
          <Banner
            tone="danger"
            title="You lost control of this session"
            actions={
              <Button size="sm" onClick={() => void lock.take()} loading={lock.busy === "take"}>
                Take control again
              </Button>
            }
          >
            The lock expired or a superadmin took over. Slack replies in the thread have resumed.
          </Banner>
        )}

        {unsupported ? (
          <Banner tone="neutral" title="Messages go straight to the agent">
            This deployment has no lock backend, so sending from here does not pause Slack. People in the thread may be talking to
            the agent at the same time.
          </Banner>
        ) : lock.mine ? (
          <Banner
            tone="accent"
            title="You are driving this session"
            actions={
              <Button size="sm" onClick={() => void lock.release()} loading={lock.busy === "release"}>
                Release control
              </Button>
            }
          >
            Slack replies in the thread are paused until you release it or leave this page.
          </Banner>
        ) : someoneElse ? (
          <Banner
            tone="warning"
            title={`${lock.owner} is driving this session`}
            actions={
              <Button
                size="sm"
                variant="danger"
                disabled={!isSuperadmin}
                title={isSuperadmin ? undefined : "Only a superadmin can take over a session"}
                onClick={() => setConfirmTakeover(true)}
              >
                Take over
              </Button>
            }
          >
            {isSuperadmin
              ? "Slack is paused for them. Taking over moves control to you and is recorded in the audit trail."
              : "Slack is paused for them. Only a superadmin can take over; ask them to release it."}
          </Banner>
        ) : (
          !lock.lost && (
            <Banner
              tone="neutral"
              title="Take control to chat in this session"
              actions={
                <Button size="sm" variant="primary" onClick={() => void lock.take()} loading={lock.busy === "take"}>
                  Take control
                </Button>
              }
            >
              While you hold it, the agent's replies stay in the console and messages from Slack wait until you release it.
            </Banner>
          )
        )}

        {lock.error && !someoneElse && (
          <p className="sl-form__error" role="alert">
            {lock.error}
          </p>
        )}

        <form className={cx("sl-composer", !canType && "is-disabled")} onSubmit={send}>
          <label htmlFor={`chat-${sessionId}`} className="sl-visually-hidden">
            Message
          </label>
          <textarea
            id={`chat-${sessionId}`}
            className="sl-input sl-composer__input"
            rows={2}
            placeholder={canType ? "Message the agent as an operator" : "Take control to send a message"}
            value={text}
            disabled={!canType}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-describedby={`chat-${sessionId}-hint`}
          />
          <div className="sl-composer__foot">
            <span id={`chat-${sessionId}-hint`} className="sl-caption">
              Enter sends, Shift+Enter adds a line.
            </span>
            <Button type="submit" variant="primary" size="sm" disabled={!canType || !text.trim()} loading={sending}>
              Send
            </Button>
          </div>
        </form>
        {sendError && (
          <p className="sl-form__error" role="alert">
            {sendError}
          </p>
        )}
      </div>

      <Dialog
        open={confirmTakeover}
        onClose={() => setConfirmTakeover(false)}
        size="sm"
        title="Take over this session?"
        description={`${lock.owner ?? "Another operator"} loses control right away and can no longer send messages here. This is recorded in the audit trail.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmTakeover(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void takeover()} loading={lock.busy === "force"}>
              Take over
            </Button>
          </>
        }
      >
        {lock.error && (
          <p className="sl-form__error" role="alert">
            {lock.error}
          </p>
        )}
      </Dialog>
    </div>
  );
}
