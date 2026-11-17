import { env } from "../../config/env";
import { channelTrustFor } from "../../knowledge/scope";
import { soulDataFor, trustSoulFor } from "../../soul/per-persona";

export type EngageLevel = "mention" | "addressed" | "contribute";
export type EngageMode = "shadow" | "on";
export interface EngageSetting {
  level: EngageLevel;
  mode: EngageMode;
}

/**
 * The engage setting for a persona in a channel. Level: the channel's own
 * `engage.level`, else the deployment default (SLAUDE_ENGAGE_DEFAULT); mode:
 * the channel's own, else shadow. A restricted channel (one neither listed
 * as public nor trusted for the persona) is always `mention`. With no config
 * anywhere the answer is { mention, shadow }, which changes nothing.
 */
export function engageFor(personaId: string | null | undefined, channelId: string): EngageSetting {
  const soul = soulDataFor(personaId);
  const own = soul.channelEngage.find((c) => c.channel === channelId);
  const mode: EngageMode = own?.mode ?? "shadow";
  if (channelTrustFor(channelId, trustSoulFor(personaId)) === "unknown") return { level: "mention", mode };
  return { level: own?.level ?? env.engageDefault(), mode };
}

/** The persona's aliases as written (the agent's own name is not included). */
export function aliasesFor(personaId: string | null | undefined): string[] {
  return soulDataFor(personaId).aliases;
}
