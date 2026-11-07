/**
 * A persona's mandate text, one reading shared by the scheduler (heartbeat
 * and wake prompts) and the console's mandate read model, so the two never
 * disagree about what an agent was asked to do.
 *
 * Precedence:
 *  - default persona: the effective default soul (`soulData()`, runtime
 *    overrides included);
 *  - named persona: its soul text (`personaSoulText`: the managed soul, else
 *    its SOUL.md file; a persona with neither reads the default persona's soul
 *    text), then the cached LLM extraction of exactly that text, else the
 *    deterministic `## Mandate` / `## Channel` `### Mandate` parse, so a
 *    fresh soul edit (no cache entry yet) never loses its mandates.
 *
 * Never throws: an unreadable soul reads as no mandates.
 */
import { personaSoulText } from "../persona/soul-source";
import type { SoulData } from "./data";
import { cachedSoulData, channelMandate, soulData } from "./extract";
import { parseMandates } from "./proactive";

export interface PersonaMandateText {
  global: string;
  /** The persona's `## Identity` voice, when it has one (extracted souls only). */
  voice?: string;
  /** Channel id -> that channel block's own mandate (null: it follows the global one). */
  channels: Record<string, string | null>;
}

function fromSoul(soul: SoulData): PersonaMandateText {
  const channels: Record<string, string | null> = {};
  for (const c of soul.channelOverrides) channels[c.channel] = channelMandate(soul, c.channel);
  return { global: soul.mandate?.trim() ?? "", ...(soul.identity?.voice ? { voice: soul.identity.voice } : {}), channels };
}

export function personaMandateText(personaId: string | null | undefined): PersonaMandateText {
  try {
    if (!personaId || personaId === "default") return fromSoul(soulData());
    const text = personaSoulText(personaId);
    const cached = cachedSoulData(text);
    if (cached) return fromSoul(cached);
    const parsed = parseMandates(text);
    return { global: parsed.global.trim(), channels: parsed.channels };
  } catch {
    return { global: "", channels: {} };
  }
}
