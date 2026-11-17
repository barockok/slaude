import { engageFor } from "./setting";
import { engageState } from "./budget";
import { lastSpeakers, type SpeakerPlace } from "./last-speaker";

/** A Slack message ts. */
const TS = /^\d+\.\d+$/;

export interface AgentMessage {
  channel: string;
  /** The thread it was posted in; null for a top-level post. */
  thread: string | null;
  ts: string;
  /** The persona name; absent for the default persona. */
  persona?: string | null;
  app?: string | null;
  /** The person the agent answered, when the post is a reply to a turn. */
  repliedToUser?: string | null;
  /** The record comes from the agent's echo, which knows less than the outbound path. */
  fromEcho?: boolean;
}

/**
 * Remember that the agent just spoke, for the next human message there to
 * find. Observe only: with the channel at `mention` (the default) it does
 * nothing at all, and it never throws or waits on the caller's path.
 *
 * The record is per persona (two agents in a channel keep their own). A
 * top-level post is recorded under its own ts (the place its replies land)
 * and under the channel's top level; a post in a thread, under the thread.
 */
export function noteAgentMessage(m: AgentMessage): void {
  try {
    if (!m.channel || !TS.test(m.ts)) return;
    const persona = m.persona && m.persona !== "default" ? m.persona : undefined;
    if (engageFor(persona, m.channel).level === "mention") return;
    const rec = { ts: m.ts, persona: persona ?? "default", app: m.app ?? "", repliedToUser: m.repliedToUser ?? null };
    const who = persona ?? "default";
    const places: SpeakerPlace[] = m.thread
      ? [{ channel: m.channel, thread: m.thread, persona: who }]
      : [{ channel: m.channel, thread: m.ts, persona: who }, { channel: m.channel, thread: null, persona: who }];
    // The agent spoke: a classifier "no" earlier in this thread no longer covers later messages.
    void engageState().clearPass(m.channel, m.thread ?? m.ts, persona ?? "default").catch(() => {});
    for (const place of places) void lastSpeakers().put(place, rec, m.fromEcho ? { ifAbsent: true } : {}).catch(() => {});
  } catch {
    /* observing must never fail a post */
  }
}

/**
 * A human message that is handled some other way (an @mention, a reply in a
 * thread the agent is engaged in) is a message after the agent's: the record
 * is stale, so drop it. A cheap delete, and nothing at all at level `mention`.
 */
export function clearAgentRecord(m: { channel: string; thread: string | null; persona?: string | null }): void {
  try {
    const persona = m.persona && m.persona !== "default" ? m.persona : undefined;
    if (!m.channel || engageFor(persona, m.channel).level === "mention") return;
    void lastSpeakers().clear({ channel: m.channel, thread: m.thread, persona: persona ?? "default" }).catch(() => {});
  } catch {
    /* observing must never fail a message */
  }
}
