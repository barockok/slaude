/**
 * Owner guardrails on the gateway (and in a mono process): the session
 * resolver and audit sink the agent manager uses, the boot snapshot and its
 * reload, and the inbound check that runs before a turn.
 *
 * Inbound rules (design section 4) run in preTurnDropReason after admission:
 * a deny drops the message with the rule's message as a thread reply, at most
 * one reply per person per thread per quiet window (later denies are silent
 * and audited). The decision gate's read-only ingressDrops path sees the same
 * drop and never posts or audits; handleMessage does both, once. Not covered,
 * and documented: cron dispatch, panel chat and /compact.
 */
import type { AgentManager, GuardrailSink } from "../../agent/manager";
import { env } from "../../config/env";
import { auditDelivery, auditFiring, firingEvents, type FiringEvent } from "../../guardrails/audit";
import { combine, textRuleMatches } from "../../guardrails/match";
import { inboundTriggered, sessionGuardrails, type SessionGuardrails } from "../../guardrails/resolve";
import { cachedGuardrails, currentGuardrails, onGuardrailsChanged, refreshGuardrails, startGuardrailRevalidation } from "../../guardrails/snapshot";
import { publishConfigReload } from "./config-reload";
import type { PubSub } from "../../queue/pubsub";

/** The session guardrails of `persona` in `channel` from the verified snapshot. Throws when unavailable. */
export async function gatewaySessionGuardrails(persona: string, channel: string | null, ctx: { tenant?: string; sessionId?: string } = {}): Promise<SessionGuardrails> {
  const snap = await currentGuardrails(ctx.tenant ?? "default", { persona, sessionId: ctx.sessionId ?? null });
  return sessionGuardrails(snap.resolved, persona, channel, { version: snap.version, proseMax: env.guardrailProseMax() });
}

/** Records firings and deliveries through the audit writer (this process has the database). */
export const auditSink: GuardrailSink = {
  firing: (sessionId, events, ctx) => {
    for (const e of events) auditFiring(e, { persona: ctx.persona, sessionId, channelId: ctx.channelId, kind: ctx.kind });
  },
  delivered: (sessionId, slugs, ctx) => auditDelivery(slugs, { persona: ctx.persona, sessionId, channelId: ctx.channelId, kind: ctx.kind, via: ctx.via, toolName: ctx.toolName }),
};

/**
 * Wire the manager and keep the snapshot current. The first load happens now
 * (a failure is held and refuses session boots, never the gateway's own
 * boot); a change (a local write, another replica's write seen by the poll)
 * announces a config reload, so nodes drop cached bundles, and in mono asks
 * every warm session on another version to reload after its turn.
 */
export function installOwnerGuardrails(agent: AgentManager, o: { pubsub: PubSub | null; tenant?: string; mono: boolean; pollMs?: number }): () => void {
  const tenant = o.tenant ?? "default";
  agent.setGuardrailResolver((sessionId, persona, channel) => gatewaySessionGuardrails(persona ?? "default", channel, { tenant, sessionId }));
  agent.setGuardrailSink(auditSink);
  void refreshGuardrails(tenant).catch(() => {});
  const stopPoll = startGuardrailRevalidation(tenant, o.pollMs);
  const off = onGuardrailsChanged((t, snap) => {
    if (t !== tenant) return;
    void publishConfigReload(o.pubsub, t);
    if (o.mono && snap) {
      const n = agent.reloadForGuardrails(snap.version);
      if (n) console.log(`[guardrails] version ${snap.version}: ${n} warm session(s) reload after their turn`);
    }
  });
  return () => {
    stopPoll();
    off();
  };
}

export interface InboundVerdict {
  /** The strictest inbound rule's action, or null when none matched. */
  action: "deny" | "audit" | null;
  /** The deciding rule's message (deny), to post as the thread reply. */
  message: string;
  slug: string | null;
  events: FiringEvent[];
}

/**
 * The enforced inbound rules of `persona` in `channel` against `text`, from
 * the cached snapshot (loaded once if this process has none yet). No snapshot
 * (it failed verification): no verdict here; the turn's session boot then
 * fails closed on the same snapshot.
 */
export async function inboundVerdict(persona: string, channel: string, text: string, tenant = "default"): Promise<InboundVerdict | null> {
  const g = await cachedSession(persona, channel, tenant);
  if (!g || g.inboundRules.length === 0) return null;
  const hits = g.inboundRules.filter((h) => textRuleMatches(h.rule, "inbound", text));
  const d = combine(hits);
  if (!d) return null;
  return {
    action: d.action === "deny" ? "deny" : "audit",
    message: d.deciding.rule.message.trim() || `This message was not passed on: it matches the owner's guardrail ${d.deciding.slug}.`,
    slug: d.deciding.slug,
    events: firingEvents("inbound", d.hits, d.deciding),
  };
}

/** On-match Guidance an inbound message triggers (delivered once per session by the manager). */
export async function inboundGuidance(persona: string, channel: string, text: string, tenant = "default"): Promise<Array<{ slug: string; name: string; body: string }>> {
  const g = await cachedSession(persona, channel, tenant);
  if (!g) return [];
  return inboundTriggered(g, text, channel).map((o) => ({ slug: o.slug, name: o.name, body: o.body }));
}

async function cachedSession(persona: string, channel: string, tenant: string): Promise<SessionGuardrails | null> {
  let snap = cachedGuardrails(tenant);
  if (!snap) {
    try {
      snap = await currentGuardrails(tenant);
    } catch {
      return null;
    }
  }
  return sessionGuardrails(snap.resolved, persona, channel, { version: snap.version, proseMax: env.guardrailProseMax() });
}

/**
 * At most one guardrail reply per person per thread per window (default 10
 * minutes). In-process: two replicas may each reply once. Bounded.
 */
export function makeReplyQuiet(windowMs: () => number = () => env.guardrailReplyQuietSec() * 1000, cap = 5000, now: () => number = Date.now) {
  const until = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    const u = until.get(key);
    if (u !== undefined && u > t) return false;
    until.delete(key);
    until.set(key, t + windowMs());
    if (until.size > cap) until.delete(until.keys().next().value as string);
    return true;
  };
}
