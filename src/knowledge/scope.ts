import type { SoulData } from "../soul/data";

export type ChannelTrust = "trusted" | "public" | "unknown";

/**
 * Synthetic identity threaded into gbrain's OperationContext.auth — gbrain's
 * fail-closed SQL scoping (sourceScopeOpts) does the actual enforcement.
 */
export interface BrainScope {
  clientId: string;
  /** Write authority — a single gbrain source. */
  sourceId: string;
  /** Federated read union. */
  allowedSources: string[];
}

export interface ScopeInput {
  /** null = agent-initiated turn (cron, internal maintenance). */
  userId: string | null;
  /** /1on1 lock owner for this thread, if locked. */
  lockedUser: string | null;
  channelTrust: ChannelTrust;
  isManager: boolean;
  kbSources: string[];
}

export const AGENT_SOURCE = "agent";
export const SHARED_SOURCE = "shared";
export const PUBLIC_SOURCE = "public";

// gbrain source ids must match [a-z0-9-]{1,32}
const sourceSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");

export function userSourceId(userId: string): string {
  return ("user-" + sourceSafe(userId).replace(/-/g, "")).slice(0, 32);
}

export function kbSourceId(label: string): string {
  return ("kb-" + label.toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 32);
}

export function channelTrustFor(channel: string, soul: SoulData): ChannelTrust {
  if (soul.trustedChannels.includes(channel)) return "trusted";
  if (soul.allowedChannels.includes(channel)) return "public";
  return "unknown";
}

export function resolveBrainScope(i: ScopeInput): BrainScope {
  if (i.userId === null) {
    return {
      clientId: "agent",
      sourceId: AGENT_SOURCE,
      allowedSources: [AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
    };
  }
  if (i.lockedUser !== null) {
    if (i.lockedUser === i.userId) {
      const own = userSourceId(i.userId);
      return {
        clientId: i.userId,
        sourceId: own,
        allowedSources: [own, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
      };
    }
    if (!i.isManager) {
      // someone else's private thread — most restrictive scope
      return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
    }
  }
  if (i.channelTrust === "trusted" || i.isManager) {
    return {
      clientId: i.userId,
      sourceId: SHARED_SOURCE,
      allowedSources: [SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
    };
  }
  return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
}
