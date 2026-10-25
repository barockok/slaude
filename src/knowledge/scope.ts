import { createHash } from "node:crypto";
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
  /** The speaker's profile source (`profileSourceId(team, speaker)`), set
   *  exactly when it is in `allowedSources`. Never the write target here:
   *  profile writes are an explicit, speaker-only target (phase C §8.6). */
  profileSource?: string;
}

export interface ScopeInput {
  /** null = agent-initiated turn (cron, internal maintenance). */
  userId: string | null;
  /** Slack team (workspace) of the turn. Keys the speaker's profile source,
   *  which is per workspace; null = unknown, so no profile is read. */
  teamId: string | null;
  /** /1on1 lock owner for this thread, if locked. */
  lockedUser: string | null;
  channelTrust: ChannelTrust;
  isManager: boolean;
  kbSources: string[];
  /** This agent's stable identity — anchors its private `agent-<id>` slice.
   *  Resolved once at boot (SLAUDE_AGENT_ID or auth.test); see agent-identity.ts. */
  agentId: string;
}

/** Legacy single-agent source. Kept in the agent read union for continuity with
 *  brains created before per-agent slices — new writes target `agent-<id>`. */
export const AGENT_SOURCE = "agent";
export const SHARED_SOURCE = "shared";
export const PUBLIC_SOURCE = "public";

// gbrain source ids must match [a-z0-9-]{1,32}
const sourceSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");

export function userSourceId(userId: string): string {
  return ("user-" + sourceSafe(userId).replace(/-/g, "")).slice(0, 32);
}

/** Per-agent private slice — mirror of userSourceId, keyed on the agent's own
 *  identity so multiple agents sharing one brain never collide on `agent`. */
export function agentSourceId(agentId: string): string {
  return ("agent-" + sourceSafe(agentId).replace(/-/g, "")).slice(0, 32);
}

/** Prefix of every person-owned profile source (spec §8.1, §8.3b). */
export const PROFILE_PREFIX = "profile-";

/**
 * One profile per person per Slack workspace: shared by every persona in the
 * tenant, never across workspaces (user ids are global on Enterprise Grid).
 * `profile-<team>-<user>`; when that exceeds gbrain's 32-char id limit, the
 * first 24 hex chars of sha256(team:user) instead, so long ids never collide
 * by truncation. The prefix keeps it apart from every `user-`, `agent-`,
 * `kb-`, `shared` and `public` id.
 */
export function profileSourceId(teamId: string, userId: string): string {
  const plain = PROFILE_PREFIX + sourceSafe(teamId).replace(/-/g, "") + "-" + sourceSafe(userId).replace(/-/g, "");
  if (plain.length <= 32) return plain;
  return PROFILE_PREFIX + createHash("sha256").update(teamId + ":" + userId).digest("hex").slice(0, 24);
}

/** True for an id `profileSourceId` can produce (either form). */
export const isProfileSourceId = (s: string): boolean => /^profile-[a-z0-9]+(?:-[a-z0-9]+)?$/.test(s) && s.length <= 32;

export function kbSourceId(label: string): string {
  return ("kb-" + label.toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 32);
}

export function channelTrustFor(channel: string, soul: SoulData): ChannelTrust {
  if (soul.trustedChannels.includes(channel)) return "trusted";
  if (soul.allowedChannels.includes(channel)) return "public";
  return "unknown";
}

/**
 * The turn's KB scope. Every row with a known speaker (and team) also reads
 * the speaker's own profile, right after the row's own sources — including a
 * public channel and someone else's /1on1, where it is the ONLY private
 * source: a person's profile follows that person, never the lock owner, and
 * never the rest of their `user-` slice. The write target is unchanged.
 */
export function resolveBrainScope(i: ScopeInput): BrainScope {
  const base = baseScope(i);
  if (!i.userId || !i.teamId) return base; // null, or an empty id from a token
  const profile = profileSourceId(i.teamId, i.userId);
  return { ...base, allowedSources: [...base.allowedSources, profile], profileSource: profile };
}

function baseScope(i: ScopeInput): BrainScope {
  const agentSrc = agentSourceId(i.agentId);
  // The agent's own mind is readable on EVERY turn it runs, regardless of who is
  // talking (it holds its identity across turns). Legacy `agent` rides along for
  // continuity with pre-per-agent brains. These are read-only here except when
  // agentSrc is also the write target.
  const agentReads = [agentSrc, AGENT_SOURCE];
  if (i.userId === null) {
    // Background/cron turn — the agent operating purely as itself.
    return {
      clientId: i.agentId,
      sourceId: agentSrc,
      allowedSources: [...agentReads, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
    };
  }
  if (i.lockedUser !== null) {
    if (i.lockedUser === i.userId) {
      const own = userSourceId(i.userId);
      return {
        clientId: i.userId,
        sourceId: own,
        allowedSources: [own, ...agentReads, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
      };
    }
    if (!i.isManager) {
      // someone else's private thread — most restrictive scope
      return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
    }
  }
  if (i.channelTrust === "trusted" || i.isManager) {
    // Default durable-write target is the agent's OWN private mind (auto-passes
    // the gate). Escalation to the shared team KB is explicit and deliberate —
    // kb_memoize target:"shared" overrides sourceId to SHARED_SOURCE, which cards.
    // clientId is the agent here (was the user pre-per-agent). gbrain uses
    // clientId only for takesHoldersAllowList (takes-visibility filtering), NOT
    // page authorship/created_by or access control — those key on sourceId — so
    // this re-attribution is benign and consistent with agent-slice writes (C4).
    return {
      clientId: i.agentId,
      sourceId: agentSrc,
      allowedSources: [...agentReads, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
    };
  }
  return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
}
