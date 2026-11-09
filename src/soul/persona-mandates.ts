/**
 * A persona's mandate text, one reading shared by the scheduler (heartbeat
 * and wake prompts) and the console's mandate read model, so the two never
 * disagree about what an agent was asked to do.
 *
 * Precedence:
 *  - default persona: the effective default soul (`soulData()`, runtime
 *    overrides included);
 *  - a persona defined by an agent.yaml: its compiled structure, only;
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
import { mandateContext, resolveMandate, subMandatesOf, type ChannelClasses, type MandateContext, type ResolvedMandate, type SubMandate } from "./mandate-scope";
import { compiledSoulFor, soulDataFor } from "./per-persona";
import { parseScopedMandates } from "./proactive";

export interface PersonaMandateText {
  global: string;
  /** The persona's `## Identity` voice, when it has one (extracted souls only). */
  voice?: string;
  /** Channel id -> that channel block's own mandate (null: it follows the global one). */
  channels: Record<string, string | null>;
  /** Every sub-mandate, with its boundary and mode. */
  subMandates: SubMandate[];
  /** The lists that put a channel in a trust class for this persona. */
  classes: ChannelClasses;
}

const NO_CLASSES: ChannelClasses = { trustedChannels: [], allowedChannels: [] };

function fromSoul(soul: SoulData, classes: ChannelClasses): PersonaMandateText {
  const channels: Record<string, string | null> = {};
  for (const c of soul.channelOverrides) channels[c.channel] = channelMandate(soul, c.channel);
  return { global: soul.mandate?.trim() ?? "", ...(soul.identity?.voice ? { voice: soul.identity.voice } : {}), channels, subMandates: subMandatesOf(soul), classes };
}

export function personaMandateText(personaId: string | null | undefined): PersonaMandateText {
  try {
    if (!personaId || personaId === "default") {
      const soul = soulData();
      return fromSoul(soul, soul);
    }
    const compiled = compiledSoulFor(personaId);
    if (compiled) return fromSoul(compiled, soulDataFor(personaId));
    const text = personaSoulText(personaId);
    const classes = soulDataFor(personaId);
    const cached = cachedSoulData(text);
    if (cached) return fromSoul(cached, classes);
    const parsed = parseScopedMandates(text);
    const subMandates = subMandatesOf({
      channelOverrides: Object.entries(parsed.channels).map(([channel, mandate]) => ({ channel, mandate, mandateMode: parsed.modes[channel], approvers: [] })),
      scopeMandates: parsed.scopes,
    });
    return { global: parsed.global.trim(), channels: parsed.channels, subMandates, classes };
  } catch {
    return { global: "", channels: {}, subMandates: [], classes: NO_CLASSES };
  }
}

/** The mandate a persona reads in `channelId`: one resolver for every prompt and the console. */
export function effectiveMandateIn(text: PersonaMandateText, channelId: string | null | undefined): ResolvedMandate {
  return resolveMandate(text.global, text.subMandates, mandateContext(text.classes, channelId));
}

/** The mandate for a whole boundary, with no particular channel in hand. */
export function effectiveMandateAt(text: PersonaMandateText, context: MandateContext): ResolvedMandate {
  return resolveMandate(text.global, text.subMandates, context);
}
