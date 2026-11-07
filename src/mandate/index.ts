/**
 * Mandates: the jobs an agent (persona) holds. Phase 1 is a read model computed
 * from what already exists (SOUL.md stays authoritative), never stored:
 *
 *  - `global`: the soul's `## Mandate` (trigger: any admitted message).
 *  - `channel:<id>`: each `## Channel` block, with its own `### Proactive`
 *    switch. A block with no mandate text (approvers or proactive only) is
 *    listed with `inheritsGlobal`.
 *  - `heartbeat`: the `## Proactive` block when enabled.
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
import { channelMandate } from "../soul/extract";
import { effectiveSoulForChannelFor, soulDataFor } from "../soul/per-persona";
import { parseProactive, type ProactiveConfig } from "../soul/proactive";

export interface Mandate {
  id: string;
  kind: "global" | "channel" | "cron" | "heartbeat";
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
  /** A channel block with no mandate text of its own: the global mandate applies there. */
  inheritsGlobal?: boolean;
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

function cronTitle(prompt: string): string {
  const first = prompt.trim().split(/\r?\n/, 1)[0]!.trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 3)}...` : first;
}

export async function listMandates(personaName: string): Promise<Mandate[]> {
  const persona = personaName && personaName !== "default" ? personaName : "default";
  const isDefault = persona === "default";
  const soul = soulDataFor(persona);
  const proactive = proactiveOf(persona);
  const approversIn = async (channelId?: string): Promise<string[]> =>
    isDefault ? effectiveSoulForChannelFor("default", channelId).approvers.map((a) => a.userId) : approversFor(persona, channelId);
  const out: Mandate[] = [];

  const global = soul.mandate?.trim();
  if (global) {
    out.push({ id: "global", kind: "global", title: "Global mandate", instructions: global, triggers: ["any admitted message"], approvers: await approversIn(), source: "soul" });
  }

  const channels = [...new Set([...soul.channelOverrides.map((c) => c.channel), ...Object.keys(proactive?.channels ?? {})])].sort();
  for (const channelId of channels) {
    const own = channelMandate(soul, channelId);
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
    if (!own) m.inheritsGlobal = true;
    const enabled = proactive?.channels[channelId];
    if (enabled !== undefined) {
      const highest = proactive!.channelHighest[channelId];
      m.proactive = highest ? { enabled, highest } : { enabled };
    }
    out.push(m);
  }

  if (proactive?.enabled) {
    const watch = proactive.watch.length ? proactive.watch.join(", ") : "no sources";
    out.push({
      id: "heartbeat",
      kind: "heartbeat",
      title: "Heartbeat",
      instructions: `Watches: ${watch}. Highest action: ${proactive.highest}.`,
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
