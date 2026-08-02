import type { SoulData } from "../soul/data";

export type ChannelTrust = "trusted" | "public" | "unknown";

/**
 * What the current turn may SURFACE from audience-tiered sources (the agent's
 * own mind). Levels are turn contexts, not people: "all" = the agent working
 * alone (background/cron), "manager" = a manager turn, "team" = a trusted
 * channel or own-/1on1 turn, "public" = an allowed (public) channel turn.
 * Page tiers (see audience.ts): private < manager < team (default) < public,
 * plus `user:<id>` (visible only when that user is the current speaker).
 */
export interface AudienceGrant {
  level: "all" | "manager" | "team" | "public";
  /** Current speaker — unlocks `user:<id>`-tiered pages for that user. */
  userId: string | null;
}

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
  /**
   * Disclosure filter for the agent's own mind. gbrain enforces SOURCE scoping
   * in SQL; audience tiers are a slaude-side per-PAGE filter applied on top,
   * only to `audienceSources`. Absent = unrestricted (back-compat: agentScope()
   * and internal callers). See src/knowledge/audience.ts.
   */
  audience?: AudienceGrant;
  /** Sources whose pages carry audience tiers — the agent slices. */
  audienceSources?: string[];
}

export interface ScopeInput {
  /** null = agent-initiated turn (cron, internal maintenance). */
  userId: string | null;
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

export function kbSourceId(label: string): string {
  return ("kb-" + label.toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 32);
}

export function channelTrustFor(channel: string, soul: SoulData): ChannelTrust {
  if (soul.trustedChannels.includes(channel)) return "trusted";
  if (soul.allowedChannels.includes(channel)) return "public";
  return "unknown";
}

export function resolveBrainScope(i: ScopeInput): BrainScope {
  const agentSrc = agentSourceId(i.agentId);
  // The agent's own mind is readable on EVERY turn it runs, regardless of who is
  // talking (it holds its identity across turns). Legacy `agent` rides along for
  // continuity with pre-per-agent brains. These are read-only here except when
  // agentSrc is also the write target.
  const agentReads = [agentSrc, AGENT_SOURCE];
  if (i.userId === null) {
    // Background/cron turn — the agent operating purely as itself. Sees every
    // audience tier of its own mind, including `private`.
    return {
      clientId: i.agentId,
      sourceId: agentSrc,
      allowedSources: [...agentReads, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
      audience: { level: "all", userId: null },
      audienceSources: agentReads,
    };
  }
  // Manager turns surface manager-tier pages (but not `private` — that tier is
  // the agent's alone in conversation; the operator can always inspect the db).
  const userLevel = i.isManager ? "manager" as const : "team" as const;
  if (i.lockedUser !== null) {
    if (i.lockedUser === i.userId) {
      const own = userSourceId(i.userId);
      return {
        clientId: i.userId,
        sourceId: own,
        allowedSources: [own, ...agentReads, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
        audience: { level: userLevel, userId: i.userId },
        audienceSources: agentReads,
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
      audience: { level: userLevel, userId: i.userId },
      audienceSources: agentReads,
    };
  }
  if (i.channelTrust === "public") {
    // Allowed (public) channel: the agent's mind rides along READ-ONLY, filtered
    // to `public`-tier (and the speaker's own `user:<id>`) pages. Unlabeled
    // pages default to `team` tier, so they stay hidden here — fail closed.
    // Writes still target the public source (WRITE_OPS deny in gated-dispatch).
    return {
      clientId: i.userId,
      sourceId: PUBLIC_SOURCE,
      allowedSources: [PUBLIC_SOURCE, ...agentReads],
      audience: { level: "public", userId: i.userId },
      audienceSources: agentReads,
    };
  }
  return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
}
