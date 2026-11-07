/**
 * Mandates: the jobs an agent (persona) holds. Phase 1 is a read model computed
 * from what already exists (SOUL.md stays authoritative), never stored:
 *
 *  - `global`: the soul's `## Mandate` (trigger: any admitted message).
 *  - `channel:<id>`: each `## Channel` block with its own mandate, with that
 *    channel's effective approvers and its own `### Proactive` switch.
 *  - `heartbeat`: the `## Proactive` block when enabled.
 *  - `cron:<id>`: each active, unpaused `cron_jobs` row of the persona.
 *
 * See docs/superpowers/specs/2026-11-07-agent-platform-design.md, "Mandate".
 */
import * as CronJobs from "../db/cron-jobs";
import { personaSoulText } from "../persona/soul-source";
import type { Level } from "../proactive/levels";
import type { ApproverEntry, SoulData } from "../soul/data";
import { channelMandate, withManagerApprover } from "../soul/extract";
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
}

const TITLE_MAX = 80;

const ids = (approvers: ApproverEntry[]): string[] => approvers.map((a) => a.userId);

/** Persona-level approvers: the global list with manager and backup appended. */
function personaApprovers(soul: SoulData): string[] {
  return ids(withManagerApprover(soul.approvers, soul));
}

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
  const soul = soulDataFor(persona);
  const approvers = personaApprovers(soul);
  const proactive = proactiveOf(persona);
  const out: Mandate[] = [];

  const global = soul.mandate?.trim();
  if (global) {
    out.push({ id: "global", kind: "global", title: "Global mandate", instructions: global, triggers: ["any admitted message"], approvers, source: "soul" });
  }

  const blocks = [...soul.channelOverrides].sort((a, b) => (a.channel < b.channel ? -1 : 1));
  for (const { channel: channelId, approvers: own } of blocks) {
    const instructions = channelMandate(soul, channelId);
    if (!instructions) continue;
    const m: Mandate = {
      id: `channel:${channelId}`,
      kind: "channel",
      title: `Mandate in <#${channelId}>`,
      instructions,
      triggers: [`messages in <#${channelId}>`],
      // A block with its own approvers replaces the global list (manager and
      // backup appended); one without inherits the persona-level list.
      approvers: own.length ? ids(effectiveSoulForChannelFor(persona, channelId).approvers) : approvers,
      source: "soul",
      channelId,
    };
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
      approvers,
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
      approvers,
      source: "cron",
      channelId: j.channelId,
      lastRunAt: j.lastRunAt,
      schedule: j.cronExpr,
    });
  }
  return out;
}
