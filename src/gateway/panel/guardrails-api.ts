/**
 * Console read model and the one write (enable/disable) for owner guardrails
 * (design section 6, phase A1). Reads for any operator; the switch is
 * superadmin only, audited, and announced with publishConfigReload so nodes
 * drop cached bundles and warm sessions reload after their turn.
 *
 *   GET  /panel/api/guardrails                    the list
 *   GET  /panel/api/guardrails/:slug              one guardrail
 *   PUT  /panel/api/guardrails/:slug/enabled      { enabled } (superadmin)
 *   GET  /panel/api/agents/:name/guardrails       what applies to one agent
 *
 * Editing, create, delete and the Test box are phase B.
 */
import { db, dbDialect } from "../../db/client";
import { env } from "../../config/env";
import { applyGuardrailChange, UnknownGuardrailError } from "../../db/guardrails";
import { auditChange } from "../../guardrails/audit";
import { ruleView } from "../../guardrails/format";
import { appliesToAgent, isActive, sessionGuardrails, type ResolvedGuardrail } from "../../guardrails/resolve";
import { cachedGuardrails, currentGuardrails, guardrailsFailure, refreshGuardrails, type TenantSnapshot } from "../../guardrails/snapshot";
import { peekKeySource } from "../../guardrails/integrity";
import type {
  AgentGuardrailsResponse,
  GuardrailThreatModel,
  NamedChannel,
  OwnerGuardrailDetail,
  OwnerGuardrailFiring,
  OwnerGuardrailSummary,
  OwnerGuardrailsResponse,
} from "./api-types";
import type { SlackNames } from "./slack-names";

export interface GuardrailApiDeps {
  /** Every agent of the deployment ("default" first). */
  agents: () => string[];
  names?: SlackNames | null;
  /** Where turns run: nodes when there is a node queue. */
  turnsRunOn: "this-process" | "nodes";
}

const TENANT = "default";

/** The snapshot, or an empty one with the failure named (the page still renders). */
async function snapshot(): Promise<{ snap: TenantSnapshot | null; failure: string | null }> {
  try {
    return { snap: await currentGuardrails(TENANT), failure: null };
  } catch (e) {
    return { snap: cachedGuardrails(TENANT), failure: guardrailsFailure(TENANT) ?? (e as Error).message };
  }
}

export function threatModel(turnsRunOn: GuardrailApiDeps["turnsRunOn"]): GuardrailThreatModel {
  const dialect = dbDialect();
  // Never reads or creates the key: a deployment with no guardrails touches nothing.
  const keySource: GuardrailThreatModel["keySource"] = peekKeySource();
  return { db: dialect, turnsRunOn, strong: dialect === "pg" || turnsRunOn === "nodes", keySource };
}

async function named(ids: string[], names: SlackNames | null | undefined): Promise<NamedChannel[]> {
  return Promise.all(ids.map(async (id) => ({ id, label: names ? await names.channelLabel(id).catch(() => null) : null })));
}

/** Last firing or delivery per guardrail slug (one grouped read). */
async function lastFired(): Promise<Map<string, number>> {
  const rows = await db.query<{ target_id: string; at: number }>(
    `SELECT target_id, MAX(at) AS at FROM audit_events
     WHERE target_kind = 'guardrail' AND (action LIKE 'guardrail.tool.%' OR action LIKE 'guardrail.inbound.%' OR action LIKE 'guardrail.reply.%' OR action = 'guardrail.guidance.delivered')
     GROUP BY target_id`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const slug = r.target_id.split("#")[0]!;
    out.set(slug, Math.max(out.get(slug) ?? 0, Number(r.at)));
  }
  return out;
}

function skippedFor(g: ResolvedGuardrail, all: readonly ResolvedGuardrail[], agents: string[], version: number): string[] {
  if (!isActive(g) || g.meta!.load !== "always" || !g.prose) return [];
  return agents.filter((a) => appliesToAgent(g, a) && sessionGuardrails(all, a, null, { version, proseMax: env.guardrailProseMax() }).skipped.some((x) => x.slug === g.slug));
}

async function summary(g: ResolvedGuardrail, all: readonly ResolvedGuardrail[], deps: GuardrailApiDeps, version: number, fired: Map<string, number>): Promise<OwnerGuardrailSummary> {
  const m = g.meta;
  const agents = deps.agents();
  const count = (on: string) => g.rules.filter((r) => r.on === on).length;
  const unknownAgents = m?.scope === "agents" ? m.agents.filter((a) => !agents.includes(a)) : [];
  return {
    slug: g.slug,
    name: m?.name ?? g.slug,
    description: m?.description ?? "",
    scope: m?.scope ?? null,
    agents: m?.agents ?? [],
    channels: await named(m?.channels ?? [], deps.names),
    enabled: g.doc.enabled,
    authorEnabled: m?.enabled ?? false,
    active: isActive(g),
    load: m?.load ?? null,
    ruleCounts: { tool: count("tool"), reply: count("reply"), inbound: count("inbound") },
    guidance: g.prose.length > 0,
    errorCount: g.errors.length,
    source: g.doc.source,
    override: g.doc.override,
    behindSource: g.doc.behindSource,
    unknownAgents,
    appliesToNoAgent: isActive(g) && !agents.some((a) => appliesToAgent(g, a)),
    skippedFor: skippedFor(g, all, agents, version),
    lastFiredAt: fired.get(g.slug) ?? null,
  };
}

export async function listGuardrails(deps: GuardrailApiDeps, canToggle: boolean): Promise<OwnerGuardrailsResponse> {
  const { snap, failure } = await snapshot();
  const all = snap?.resolved ?? [];
  const fired = await lastFired();
  return {
    guardrails: await Promise.all(all.map((g) => summary(g, all, deps, snap?.version ?? 0, fired))),
    version: snap?.version ?? 0,
    failure,
    threatModel: threatModel(deps.turnsRunOn),
    proseMax: env.guardrailProseMax(),
    canToggle,
  };
}

async function firings(slug: string, names: SlackNames | null | undefined): Promise<OwnerGuardrailFiring[]> {
  const rows = await db.query<{ id: string; at: number; action: string; target_id: string; persona: string | null; channel_id: string | null; decision: string | null }>(
    `SELECT id, at, action, target_id, persona, channel_id, decision FROM audit_events
     WHERE target_kind = 'guardrail' AND (target_id = ? OR target_id LIKE ?) AND action NOT IN ('guardrail.created', 'guardrail.updated', 'guardrail.deleted')
     ORDER BY id DESC LIMIT 20`,
    [slug, `${slug}#%`],
  );
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      at: Number(r.at),
      action: r.action,
      ruleId: r.target_id.includes("#") ? r.target_id.slice(r.target_id.indexOf("#") + 1) : null,
      agent: r.persona,
      channel: r.channel_id ? (await named([r.channel_id], names))[0]! : null,
      decision: r.decision,
    })),
  );
}

export async function guardrailDetail(slug: string, deps: GuardrailApiDeps, canToggle: boolean): Promise<OwnerGuardrailDetail | null> {
  const { snap } = await snapshot();
  const all = snap?.resolved ?? [];
  const g = all.find((x) => x.slug === slug);
  if (!g) return null;
  const s = await summary(g, all, deps, snap?.version ?? 0, await lastFired());
  const m = g.meta;
  return {
    ...s,
    md: g.doc.md,
    prose: g.prose,
    rules: g.rules.map(ruleView),
    errors: g.errors,
    triggers: m && m.load === "on-match"
      ? { tool: m.triggers.tool.map((p) => p.source), inbound: m.triggers.inbound?.source ?? null, channels: await named(m.triggers.channels, deps.names) }
      : null,
    appliesTo: { agents: deps.agents().filter((a) => appliesToAgent(g, a)), channels: s.channels, everyChannel: s.channels.length === 0 },
    firings: await firings(slug, deps.names),
    threatModel: threatModel(deps.turnsRunOn),
    canToggle,
  };
}

export async function agentGuardrails(agent: string, deps: GuardrailApiDeps): Promise<AgentGuardrailsResponse> {
  const { snap, failure } = await snapshot();
  const all = snap?.resolved ?? [];
  const version = snap?.version ?? 0;
  const fired = await lastFired();
  const session = sessionGuardrails(all, agent, null, { version, proseMax: env.guardrailProseMax() });
  const mine = all.filter((g) => appliesToAgent(g, agent));
  return {
    agent,
    guardrails: await Promise.all(
      mine.map(async (g) => ({
        ...(await summary(g, all, deps, version, fired)),
        via: g.meta!.scope === "shared" ? ("shared" as const) : ("agent" as const),
        channelLimited: g.meta!.channels.length > 0,
        skipped: session.skipped.some((x) => x.slug === g.slug),
      })),
    ),
    prose: { chars: session.proseChars, max: env.guardrailProseMax(), skipped: session.skipped },
    failure,
  };
}

/** The kill switch: one audited write, then the reload announcement. */
export async function setGuardrailEnabled(slug: string, enabled: boolean, operatorId: string): Promise<{ version: number; changed: boolean } | null> {
  let r;
  try {
    r = await applyGuardrailChange(TENANT, { setEnabled: [{ slug, enabled }], by: operatorId });
  } catch (e) {
    if (e instanceof UnknownGuardrailError) return null;
    throw e;
  }
  if (r.toggled.length) {
    auditChange({ created: [], updated: [], removed: [], enabledChanges: [{ slug, enabled }] }, { tenantId: TENANT, actorKind: "operator", actorId: operatorId, via: "console" });
    await refreshGuardrails(TENANT);
  }
  return { version: r.version, changed: r.toggled.length > 0 };
}
