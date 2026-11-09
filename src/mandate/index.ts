/**
 * Mandates: the jobs an agent (persona) holds. Phase 1 is a read model computed
 * from what already exists (SOUL.md stays authoritative), never stored:
 *
 * The mandate text comes from {@link personaMandateText}, the same reading the
 * scheduler's heartbeat and wake prompts use: the default persona's effective
 * soul; for a named persona its soul text (managed soul or SOUL.md, else the
 * default persona's soul text), then the cached extraction of that text, else
 * the deterministic `## Mandate` / `### Mandate` parse. A named persona's
 * structured `soul_json` decides access (approvers), not its mandates here.
 *
 *  - `global`: the soul's `## Mandate` (trigger: any admitted message).
 *  - `channel:<id>`: each `## Channel` block with a mandate, and each with its
 *    own `### Proactive` switch. A block with no mandate text is listed with
 *    `inheritsGlobal`, or with `effectiveFrom` when a scope applies there. The
 *    default persona's blocks never appear under a named persona.
 *  - `scope:<boundary>`: each `## Scope dm|public|trusted` sub-mandate.
 *  - `heartbeat`: when proactive wakes are on anywhere: the `## Proactive`
 *    block, or any channel's own `### Proactive` with `Enabled: yes` (one switch).
 *  - `cron:<id>`: each active, unpaused `cron_jobs` row of the persona.
 *
 * Approvers are who can actually approve at runtime: for a named persona the
 * approval gate's resolution ({@link approversFor}, channel aware); for the
 * default persona the soul's effective approvers for the channel, which the
 * gate then narrows by scope per request (`approverNote`).
 *
 * See docs/superpowers/specs/2026-11-07-agent-platform-design.md, "Mandate".
 */
import { approversFor } from "../access/role";
import * as CronJobs from "../db/cron-jobs";
import { personaSoulText } from "../persona/soul-source";
import type { Level } from "../proactive/levels";
import { effectiveSoulForChannelFor } from "../soul/per-persona";
import type { MandateMode } from "../soul/data";
import type { MandateBoundary, SubMandate } from "../soul/mandate-scope";
import { effectiveMandateAt, effectiveMandateIn, personaMandateText } from "../soul/persona-mandates";
import { parseProactive, type ProactiveConfig } from "../soul/proactive";

export interface Mandate {
  id: string;
  kind: "global" | "channel" | "scope" | "cron" | "heartbeat";
  title: string;
  instructions: string;
  triggers: string[];
  approvers: string[];
  source: "soul" | "cron" | "proactive";
  channelId?: string;
  lastRunAt?: number | null;
  schedule?: string;
  /** A channel block's own `### Proactive` switch, when it has one. */
  proactive?: { enabled: boolean; highest?: Level };
  /** A channel block with no mandate text and no scope applying: the global mandate applies there. */
  inheritsGlobal?: boolean;
  /** A sub-mandate's place: `channel:<id>`, `trust:public`, `trust:trusted` or `dm`. */
  boundary?: MandateBoundary;
  /** How a sub-mandate combines with the global mandate. */
  mode?: MandateMode;
  /** The mandate the agent reads in this place, from the one resolver. */
  effective?: string;
  /** Which sub-mandate shaped `effective`, when it is not this card's own (a channel following a scope). */
  effectiveFrom?: MandateBoundary;
  /** How the runtime narrows `approvers` (default persona: by scope, per request). */
  approverNote?: string;
}

export const DEFAULT_APPROVER_NOTE = "scope-matched per request";

const TITLE_MAX = 80;

/** The persona's `## Proactive` config from its soul text, or null when the text cannot be read. */
function proactiveOf(persona: string): ProactiveConfig | null {
  try {
    return parseProactive(personaSoulText(persona === "default" ? undefined : persona));
  } catch {
    return null;
  }
}

const SCOPE_PLACE: Partial<Record<MandateBoundary, string>> = {
  dm: "direct messages",
  "trust:public": "public channels",
  "trust:trusted": "trusted channels",
};

function boundaryContext(sub: SubMandate): { dm: true } | { trust: "public" | "trusted" } {
  return sub.boundary === "dm" ? { dm: true } : { trust: sub.boundary === "trust:public" ? "public" : "trusted" };
}

function cronTitle(prompt: string): string {
  const first = prompt.trim().split(/\r?\n/, 1)[0]!.trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 3)}...` : first;
}

export async function listMandates(personaName: string): Promise<Mandate[]> {
  const persona = personaName && personaName !== "default" ? personaName : "default";
  const isDefault = persona === "default";
  const text = personaMandateText(persona);
  const proactive = proactiveOf(persona);
  const approversIn = async (channelId?: string): Promise<string[]> =>
    isDefault ? effectiveSoulForChannelFor("default", channelId).approvers.map((a) => a.userId) : approversFor(persona, channelId);
  const out: Mandate[] = [];

  const global = text.global;
  if (global) {
    out.push({ id: "global", kind: "global", title: "Global mandate", instructions: global, triggers: ["any admitted message"], approvers: await approversIn(), source: "soul" });
  }

  const channels = [...new Set([...Object.keys(text.channels), ...Object.keys(proactive?.channels ?? {})])].sort();
  for (const channelId of channels) {
    const own = text.channels[channelId] ?? null;
    const resolved = effectiveMandateIn(text, channelId);
    const m: Mandate = {
      id: `channel:${channelId}`,
      kind: "channel",
      title: `Mandate in <#${channelId}>`,
      instructions: own ?? "",
      triggers: [`messages in <#${channelId}>`],
      approvers: await approversIn(channelId),
      source: "soul",
      channelId,
    };
    if (own) {
      m.boundary = `channel:${channelId}`;
      m.mode = resolved.applied?.mode ?? "override";
      m.effective = resolved.text;
    } else if (resolved.applied) {
      m.effective = resolved.text;
      m.effectiveFrom = resolved.applied.boundary;
    } else {
      m.inheritsGlobal = true;
    }
    const enabled = proactive?.channels[channelId];
    if (enabled !== undefined) {
      const highest = proactive!.channelHighest[channelId];
      m.proactive = highest ? { enabled, highest } : { enabled };
    }
    out.push(m);
  }

  for (const sub of text.subMandates.filter((s) => !s.boundary.startsWith("channel:"))) {
    const where = SCOPE_PLACE[sub.boundary]!;
    out.push({
      id: `scope:${sub.boundary}`,
      kind: "scope",
      title: `Mandate in ${where}`,
      instructions: sub.text,
      triggers: [`messages in ${where}`],
      approvers: await approversIn(),
      source: "soul",
      boundary: sub.boundary,
      mode: sub.mode,
      effective: effectiveMandateAt(text, boundaryContext(sub)).text,
    });
  }

  // One switch: wakes run when the global section or any channel turns them on.
  const onChannels = proactive ? Object.entries(proactive.channels).filter(([, on]) => on).map(([id]) => id).sort() : [];
  if (proactive && (proactive.enabled || onChannels.length > 0)) {
    const parts: string[] = [];
    if (proactive.enabled) {
      parts.push(`Watches: ${proactive.watch.length ? proactive.watch.join(", ") : "no sources"}.`);
      parts.push(`Highest action: ${proactive.highest}.`);
    }
    if (onChannels.length) parts.push(`Works on its own in ${onChannels.map((c) => `<#${c}>`).join(", ")}.`);
    out.push({
      id: "heartbeat",
      kind: "heartbeat",
      title: "Heartbeat",
      instructions: parts.join(" "),
      triggers: proactive.wake ? ["heartbeat round", "wake"] : ["heartbeat round"],
      approvers: await approversIn(),
      source: "proactive",
    });
  }

  const crons = (await CronJobs.listActive()).filter((j) => j.personaId === persona && !j.paused).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const j of crons) {
    out.push({
      id: `cron:${j.id}`,
      kind: "cron",
      title: cronTitle(j.prompt),
      instructions: j.prompt,
      triggers: [`cron ${j.cronExpr}`],
      approvers: await approversIn(j.channelId),
      source: "cron",
      channelId: j.channelId,
      lastRunAt: j.lastRunAt,
      schedule: j.cronExpr,
    });
  }
  return isDefault ? out.map((m) => ({ ...m, approverNote: DEFAULT_APPROVER_NOTE })) : out;
}
