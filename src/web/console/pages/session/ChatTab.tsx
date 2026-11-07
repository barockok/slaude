import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { SessionChatResponse } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Avatar, Button, Dialog, EmptyState, IconLock, cx } from "../../../ui";
import { api } from "../../client";
import { absoluteTime, clockTime, shortDate } from "../../lib/format";
import { AgentText, SlackText } from "../../components/SlackText";
import { DeliveryMark, EarlierHeader, useFollow, type TimelineItem } from "./TimelineTab";
import type { SessionHistory } from "./useSessionHistory";
import type { SessionLock } from "./useSessionLock";
import type { SurfaceId } from "../../../../gateway/panel/api-types";
import { surfaceInfo, type SurfaceInfo } from "../../lib/surfaces";

type ChatItem = Extract<TimelineItem, { kind: "text" }>;

export interface ChatTabProps {
  sessionId: string;
  /** Agent replies, people's and operator messages since the page opened, oldest first. */
  messages: ChatItem[];
  /** Earlier turns from the conversation record, oldest first. */
  earlier: ChatItem[];
  history: SessionHistory;
  /** The surface the conversation is on (words come from the surface registry). */
  surface?: SurfaceId;
  lock: SessionLock;
  isSuperadmin: boolean;
  onSent: (text: string) => void;
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

function Message({ m, surface }: { m: ChatItem; surface: SurfaceInfo }) {
  return (
    <li className={cx("sl-chat__msg", m.who === "operator" && "is-operator", m.who === "user" && "is-user")}>
      {m.who !== "operator" && <Avatar name={m.name} size="sm" />}
      <div className="sl-chat__bubble">
        {m.who === "agent" ? (
          <AgentText text={m.text} />
        ) : (
          <p className="sl-tl__text">
            <SlackText text={m.text} />
          </p>
        )}
        <span className="sl-chat__foot">
          <time className="sl-chat__time" dateTime={new Date(m.at).toISOString()} title={m.dateOnly ? "Only the day of this line is recorded" : absoluteTime(m.at)}>
            {m.who !== "agent" ? `${m.name}${m.who === "user" ? ` in ${surface.label}` : ""}, ` : ""}
            {m.earlier ? (m.dateOnly ? shortDate(m.at) : absoluteTime(m.at)) : clockTime(m.at)}
          </time>
          {m.delivery && <DeliveryMark delivery={m.delivery} target={m.target} />}
        </span>
      </div>
    </li>
  );
}

export function ChatTab({ sessionId, messages, earlier, history, surface, lock, isSuperadmin, onSent }: ChatTabProps) {
  const sf = surfaceInfo(surface);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const { scroller: log, onScroll } = useFollow(messages.length, earlier.length);

  // Only the lock endpoints answering 503 says there is no lock backend.
  const unsupported = lock.unsupported;
  const canType = lock.mine || unsupported;
  const someoneElse = !!lock.owner && !lock.mine;
  const stolen = lock.lost && !!lock.lostTo && lock.owner === lock.lostTo;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await api.post<SessionChatResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, { text: t });
      onSent(t);
      setText("");
      // The server took the lock for this send: hold it (heartbeat, release on leave).
      if (r?.locked_by) lock.claimed();
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
      <div className="sl-chat__log" ref={log} onScroll={onScroll} tabIndex={0} aria-label="Conversation" aria-live="polite">
        <EarlierHeader history={history} count={earlier.length} />
        {earlier.length > 0 && (
          <ol className="sl-chat__list" aria-label="Earlier in this session">
            {earlier.map((m) => (
              <Message key={m.key} m={m} surface={sf} />
            ))}
          </ol>
        )}
        {messages.length === 0 && earlier.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description={`Messages from ${sf.label}, the agent's replies and messages you send from here show up in this conversation.`}
          />
        ) : (
          messages.length > 0 && (
            <>
              {earlier.length > 0 && (
                <div className="sl-tl__divider" role="separator">
                  <span>Since you opened this page</span>
                </div>
              )}
              <ol className="sl-chat__list">
                {messages.map((m) => (
                  <Message key={m.key} m={m} surface={sf} />
                ))}
              </ol>
            </>
          )
        )}
      </div>

      <div className="sl-chat__control">
        {lock.lost && !stolen && (
          <Banner
            tone="danger"
            title="Your control of this session ended"
            actions={
              <Button size="sm" onClick={() => void lock.take()} loading={lock.busy === "take"}>
                Take control again
              </Button>
            }
          >
            The lock expired or was released elsewhere, so replies in the {sf.label} {sf.conversation} have resumed.
          </Banner>
        )}

        {unsupported ? (
          <Banner tone="neutral" title="Messages go straight to the agent">
            This deployment has no lock backend, so sending from here does not pause {sf.label}. People in the {sf.conversation} may be talking to
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
            Replies in the {sf.label} {sf.conversation} are paused until you release it or leave this page.
          </Banner>
        ) : someoneElse ? (
          <Banner
            tone={stolen ? "danger" : "warning"}
            title={stolen ? `Taken over by ${lock.owner}` : `${lock.owner} is driving this session`}
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
            {stolen
              ? `${lock.owner} took control from you, so your messages no longer reach the agent. ${sf.label} stays paused while they drive it.`
              : isSuperadmin
              ? `${sf.label} is paused for them. Taking over moves control to you and is recorded in the audit trail.`
              : `${sf.label} is paused for them. Only a superadmin can take over; ask them to release it.`}
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
              While you hold it, the agent's replies stay in the console and messages from {sf.label} wait until you release it.
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
