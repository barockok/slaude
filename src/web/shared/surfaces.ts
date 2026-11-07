/**
 * The chat surfaces the console and the portal know how to talk about. Generic console UI
 * never says "Slack": it asks this registry for the surface's label, its words
 * for a conversation, and how to show a conversation id. Slack is the only
 * surface today; a new one (WhatsApp, Discord, Telegram) is a new entry here.
 *
 * Genuinely Slack-only features keep saying Slack where they live: grants and
 * the Grant dialog (subjects are Slack user, channel and workspace ids), the
 * agent's Slack user column, `/env` (a Slack command), and the Slack markup
 * renderer (SlackText).
 */
import { createContext, useContext } from "react";
import type { SurfaceId } from "../../gateway/panel/api-types";

export interface ConversationRef {
  channelId: string | null;
  threadRef: string | null;
  /** A resolved display label for the channel (`#team`, `DM with Jane Doe`). */
  channelLabel?: string | null;
}

export interface SurfaceInfo {
  id: string;
  /** Proper name, e.g. "Slack". */
  label: string;
  /** Short mark shown in badges (no images: plain text). */
  mark: string;
  /** What one conversation is called there ("thread", "chat"). */
  conversation: string;
  /** Whether conversations live in named channels on this surface. */
  hasChannels: boolean;
  /** Whether replies form threads under a message. */
  hasThreads: boolean;
  /** One line naming a conversation, e.g. `#team, thread 1762506060.000101`. */
  describe(ref: ConversationRef): string;
  /**
   * How to send the agent a text command such as `/link` there, when the
   * surface treats a leading `/` as its own (null when typing it works as is).
   */
  commandTip: string | null;
}

const slack: SurfaceInfo = {
  id: "slack",
  label: "Slack",
  mark: "S",
  conversation: "thread",
  hasChannels: true,
  hasThreads: true,
  // Slack takes a message that starts with "/" as one of its own slash
  // commands and rejects an unregistered one; the gateway parses commands from
  // message text after trimming and removing mentions, so either works.
  commandTip: "put a space before it or mention the agent, since Slack treats a message that starts with / as its own command",
  describe(ref) {
    const where = ref.channelLabel || (ref.channelId ? `#${ref.channelId}` : null);
    if (!where) return "No thread";
    // A heartbeat wake or a scheduled run keys on a synthetic thread: its label says it all.
    return ref.threadRef && !isSyntheticThread(ref.threadRef) ? `${where}, thread ${ref.threadRef}` : where;
  },
};

/** A thread key a run nobody started uses (`wake:...`, `cron:...`), not a conversation thread. */
export const isSyntheticThread = (threadRef: string | null | undefined): boolean => !!threadRef && /^(wake|cron):/.test(threadRef);

const SURFACES: Readonly<Record<string, SurfaceInfo>> = { slack };

/** The surface every record without one is on (records written before surfaces existed). */
export const DEFAULT_SURFACE = "slack";

/** The registry entry for a surface; an unknown id gets neutral words and its id as the label. */
export function surfaceInfo(id?: SurfaceId | null): SurfaceInfo {
  const key = id || DEFAULT_SURFACE;
  const known = SURFACES[key];
  if (known) return known;
  return {
    id: key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    mark: key.charAt(0).toUpperCase(),
    conversation: "conversation",
    hasChannels: false,
    hasThreads: false,
    commandTip: null,
    describe: (ref) => ref.channelLabel || ref.channelId || "No conversation",
  };
}

/** "in Slack", for a line said on a surface. */
export const inSurface = (id?: SurfaceId | null): string => `in ${surfaceInfo(id).label}`;

/** The surface of the session on screen, for the timeline and chat pieces deep in it. */
export const SessionSurface = createContext<SurfaceId>(DEFAULT_SURFACE);

/** The registry entry of the session on screen. */
export function useSessionSurface(): SurfaceInfo {
  return surfaceInfo(useContext(SessionSurface));
}

/**
 * Guidance for sending a text command, surface-neutral first: "send /link to
 * the agent as a message (in Slack, put a space before it or mention the agent ...)".
 * Every known surface with a tip is named, so the line is right wherever the person is.
 */
export function sendCommandGuidance(command: string): string {
  const tips = Object.values(SURFACES)
    .filter((s) => s.commandTip)
    .map((s) => `in ${s.label}, ${s.commandTip}`);
  return `send ${command} to the agent as a message${tips.length ? ` (${tips.join("; ")})` : ""}`;
}

/** The first letter upper-cased, for a guidance line that starts a sentence. */
export const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
