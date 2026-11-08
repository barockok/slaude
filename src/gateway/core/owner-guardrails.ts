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
import { combine, hitMessage, textHits } from "../../guardrails/match";
import { failureText } from "./failure-codes";
import { appliesToAgent, inboundTriggered, sessionGuardrails, type SessionGuardrails } from "../../guardrails/resolve";
import { cachedGuardrails, currentGuardrails, onGuardrailsChanged, refreshGuardrails, startGuardrailRevalidation } from "../../guardrails/snapshot";
import type { PubSub } from "../../queue/pubsub";
import type { Redis } from "ioredis";
import { setHighWaterRedis } from "../../guardrails/high-water";

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
 * publishes the tenant's reload signal, so nodes drop cached bundles and
 * reload warm sessions, and in mono asks every warm session on another
 * version to reload after its turn.
 */
export function installOwnerGuardrails(
  agent: AgentManager,
  o: { pubsub: PubSub | null; tenant?: string; mono: boolean; pollMs?: number; redis?: { client: Redis; prefix: string } | null },
): () => void {
  const tenant = o.tenant ?? "default";
  // Every replica and restart agrees on the high-water mark when there is a Redis.
  if (o.redis) setHighWaterRedis(o.redis.client, o.redis.prefix);
  agent.setGuardrailResolver((sessionId, persona, channel) => gatewaySessionGuardrails(persona ?? "default", channel, { tenant, sessionId }));
  agent.setGuardrailSink(auditSink);
  void refreshGuardrails(tenant).catch(() => {});
  const stopPoll = startGuardrailRevalidation(tenant, o.pollMs);
  const off = onGuardrailsChanged((t, snap) => {
    if (t !== tenant) return;
    // The node half of publishConfigReload: nodes drop cached bundles and
    // reload warm sessions. The persona registry is untouched by a guardrail
    // change, so it is not rebuilt here.
    if (o.pubsub) {
      void o.pubsub.publishReload(t).catch((e: unknown) => console.error(`[guardrails] reload publish failed tenant=${t}: ${(e as Error)?.message ?? String(e)}`));
    }
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
 * the cached snapshot (loaded once if this process has none yet). A set that
 * failed to read or verify drops the message (fail closed, never a stale
 * snapshot): the reply is the GUARDRAILS_UNAVAILABLE notice. Text too large
 * to check counts as a match for deny rules.
 */
export async function inboundVerdict(persona: string, channel: string, text: string, tenant = "default"): Promise<InboundVerdict | null> {
  const g = await cachedSession(persona, channel, tenant);
  if (g === "unavailable") return { action: "deny", message: failureText("GUARDRAILS_UNAVAILABLE"), slug: null, events: [] };
  if (g.inboundRules.length === 0) return null;
  const d = combine(textHits(g.inboundRules, "inbound", text));
  if (!d) return null;
  return {
    action: d.action === "deny" ? "deny" : "audit",
    message: d.deciding.oversize || d.deciding.rule.message.trim() ? hitMessage(d.deciding) : `This message was not passed on: it matches the owner's guardrail ${d.deciding.slug}.`,
    slug: d.deciding.slug,
    events: firingEvents("inbound", d.hits, d.deciding),
  };
}

/** On-match Guidance an inbound message triggers (delivered once per session by the manager). */
export async function inboundGuidance(persona: string, channel: string, text: string, tenant = "default"): Promise<Array<{ slug: string; name: string; body: string }>> {
  const g = await cachedSession(persona, channel, tenant);
  if (g === "unavailable") return [];
  return inboundTriggered(g, text, channel).map((o) => ({ slug: o.slug, name: o.name, body: o.body }));
}

/** The tenant's verified snapshot as a session would see it, or "unavailable" when it failed. */
async function cachedSession(persona: string, channel: string, tenant: string): Promise<SessionGuardrails | "unavailable"> {
  let snap = cachedGuardrails(tenant);
  if (!snap) {
    try {
      snap = await currentGuardrails(tenant);
    } catch {
      return "unavailable";
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

/**
 * A node's guardrail report (runtime/guardrail_event). The node is trusted to
 * say which rule fired on which tool, nothing more: the action and what was
 * applied come from the gateway's own verified rule, and an event naming a
 * guardrail or rule the gateway's set does not apply to the token's agent is
 * dropped. Context (agent, session, channel, thread) comes from the signed job
 * claims only. Flooding is bounded: a token bucket per session, and an event
 * identical to one already recorded for the same job is recorded once.
 */
export async function recordNodeGuardrailEvent(
  claims: { tenant: string; persona: string; session: string; channel: string; thread: string; job?: string },
  r: { kind: "firing" | "delivery"; sessionKind?: string; events: FiringEvent[]; slugs: string[]; via?: "tool" | "inbound"; toolName?: string },
  limits: NodeEventLimits = nodeEventLimits,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const persona = claims.persona || "default";
  let recorded = 0;
  let dropped = 0;
  let snap: Awaited<ReturnType<typeof currentGuardrails>> | null = null;
  try {
    snap = await currentGuardrails(claims.tenant || "default");
  } catch {
    snap = null;
  }
  const applies = new Map((snap?.resolved ?? []).filter((g) => appliesToAgent(g, persona)).map((g) => [g.slug, g]));
  const ctx = { tenantId: claims.tenant, persona, sessionId: claims.session, channelId: claims.channel, threadTs: claims.thread, kind: r.sessionKind ?? "interactive" };
  const admit = (key: string): boolean => {
    if (!limits.once(`${claims.session}\u0000${claims.job ?? ""}\u0000${key}`)) return false;
    if (!limits.take(claims.session)) {
      dropped++;
      return false;
    }
    return true;
  };
  if (r.kind === "firing") {
    for (const e of r.events) {
      const rule = applies.get(e.slug)?.rules.find((x) => x.id === e.ruleId && x.on === "tool");
      if (!rule) continue;
      const action = rule.action as FiringEvent["action"];
      const own: FiringEvent = { on: "tool", slug: e.slug, ruleId: rule.id, action, applied: action === "audit" ? "audit" : "deny", deciding: e.deciding, ...(e.toolName ? { toolName: e.toolName } : {}) };
      if (!admit(`f\u0000${own.slug}\u0000${own.ruleId}\u0000${own.toolName ?? ""}\u0000${own.deciding}`)) continue;
      auditFiring(own, ctx);
      recorded++;
    }
  } else {
    const ok = r.slugs.filter((s) => applies.get(s)?.meta?.load === "on-match" && admit(`d\u0000${s}`));
    if (ok.length) auditDelivery(ok, { ...ctx, via: r.via ?? "tool", ...(r.toolName ? { toolName: r.toolName } : {}) });
    recorded = ok.length;
  }
  if (dropped) console.warn(`[guardrails] session=${claims.session}: ${dropped} node guardrail event(s) over the rate limit, not recorded`);
  return { content: [{ type: "text", text: JSON.stringify({ recorded, ...(dropped ? { dropped } : {}) }) }] };
}

export interface NodeEventLimits {
  /** True the first time a key is seen (bounded memory). */
  once(key: string): boolean;
  /** True while the session's bucket has a token. */
  take(session: string): boolean;
}

/** A token bucket per session (`capacity` events, refilled at `perSec`) and a bounded once-set. */
export function makeNodeEventLimits(o: { capacity?: number; perSec?: number; cap?: number; now?: () => number } = {}): NodeEventLimits {
  const capacity = o.capacity ?? 60;
  const perSec = o.perSec ?? 2;
  const cap = o.cap ?? 10_000;
  const now = o.now ?? Date.now;
  const seen = new Set<string>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    once(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > cap) seen.delete(seen.values().next().value as string);
      return true;
    },
    take(session) {
      const t = now();
      const b = buckets.get(session) ?? { tokens: capacity, at: t };
      b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * perSec);
      b.at = t;
      buckets.delete(session);
      buckets.set(session, b);
      if (buckets.size > cap) buckets.delete(buckets.keys().next().value as string);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
  };
}

const nodeEventLimits = makeNodeEventLimits();
