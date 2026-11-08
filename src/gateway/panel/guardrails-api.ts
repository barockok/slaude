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
 * Phase B (rc.11), superadmin only, each write through applyGuardrailChange
 * (integrity, manifest, high-water mark), audited without text, followed by
 * the reload announcement exactly like the switch:
 *
 *   POST   /panel/api/guardrails                  { slug, md } create a console guardrail
 *   PUT    /panel/api/guardrails/:slug            { md, revision } edit (a file or git one gets an override)
 *   DELETE /panel/api/guardrails/:slug/override?revision=   clear the console override
 *   DELETE /panel/api/guardrails/:slug?revision=  delete a console guardrail
 *
 * Read-only for any operator (no write, no side effect):
 *
 *   POST   /panel/api/guardrails/validate         { slug, md } the server parser's verdict
 *   POST   /panel/api/guardrails/test             one event through an agent's effective set
 */
import { db, dbDialect } from "../../db/client";
import { env } from "../../config/env";
import { applyGuardrailChange, guardrailRevision, StaleGuardrailError, UnknownGuardrailError, type ChangeResult, type GuardrailChange } from "../../db/guardrails";
import { auditChange } from "../../guardrails/audit";
import { GUARDRAIL_SLUG_RE, parseGuardrail, RESERVED_SLUGS, ruleView } from "../../guardrails/format";
import { evaluateGuardrails, withDraft, type TestEvent } from "../../guardrails/evaluate";
import { GuardrailIntegrityError } from "../../guardrails/integrity";
import { emitAudit } from "../../audit/emit";
import { formatOutbound } from "../slack/outbound";
import { appliesToAgent, isActive, sessionGuardrails, type ResolvedGuardrail } from "../../guardrails/resolve";
import { cachedGuardrails, currentGuardrails, DEFAULT_TENANT, guardrailsFailure, refreshGuardrails, type TenantSnapshot } from "../../guardrails/snapshot";
import { peekKeySource } from "../../guardrails/integrity";
import type {
  AgentGuardrailsResponse,
  GuardrailTestRequest,
  GuardrailTestResponse,
  GuardrailValidation,
  GuardrailWriteError,
  GuardrailWriteResponse,
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

const TENANT = DEFAULT_TENANT;
/** Postgres: only this tenant's audit rows (sqlite has one tenant and no column). */
const tenantFilter = () => (dbDialect() === "pg" ? { sql: " AND tenant_id = ?", params: [TENANT] } : { sql: "", params: [] as string[] });

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
  const t = tenantFilter();
  const rows = await db.query<{ target_id: string; at: number }>(
    `SELECT target_id, MAX(at) AS at FROM audit_events
     WHERE target_kind = 'guardrail' AND (action LIKE 'guardrail.tool.%' OR action LIKE 'guardrail.inbound.%' OR action LIKE 'guardrail.reply.%' OR action = 'guardrail.guidance.delivered')${t.sql}
     GROUP BY target_id`,
    t.params,
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

export async function listGuardrails(deps: GuardrailApiDeps, canToggle: boolean, canEdit = canToggle): Promise<OwnerGuardrailsResponse> {
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
    canEdit,
  };
}

async function firings(slug: string, names: SlackNames | null | undefined): Promise<OwnerGuardrailFiring[]> {
  const rows = await db.query<{ id: string; at: number; action: string; target_id: string; persona: string | null; channel_id: string | null; decision: string | null }>(
    `SELECT id, at, action, target_id, persona, channel_id, decision FROM audit_events
     WHERE target_kind = 'guardrail' AND (target_id = ? OR target_id LIKE ?) AND action NOT IN ('guardrail.created', 'guardrail.updated', 'guardrail.deleted', 'guardrail.override.set', 'guardrail.override.cleared', 'guardrail.tested')${tenantFilter().sql}
     ORDER BY id DESC LIMIT 20`,
    [slug, `${slug}#%`, ...tenantFilter().params],
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

export async function guardrailDetail(slug: string, deps: GuardrailApiDeps, canToggle: boolean, canEdit = canToggle): Promise<OwnerGuardrailDetail | null> {
  const { snap } = await snapshot();
  const all = snap?.resolved ?? [];
  const g = all.find((x) => x.slug === slug);
  if (!g) return null;
  const s = await summary(g, all, deps, snap?.version ?? 0, await lastFired());
  const m = g.meta;
  const row = snap?.stored.rows.find((r) => r.slug === slug);
  const override = snap?.stored.overrides.find((o) => o.slug === slug);
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
    canEdit,
    revision: guardrailRevision(row, override) ?? 0,
    deletable: g.doc.source === "console",
    overrideOf: override && row ? { sourceMd: row.md, author: override.author, updatedAt: override.updatedAt } : null,
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
    if (e instanceof GuardrailIntegrityError) throw new GuardrailWriteRefused(423, { error: e.message, code: "integrity", hint: REPAIR_HINT });
    throw e;
  }
  if (r.toggled.length) {
    auditChange({ created: [], updated: [], removed: [], enabledChanges: [{ slug, enabled }] }, { tenantId: TENANT, actorKind: "operator", actorId: operatorId, via: "console" });
    await refreshGuardrails(TENANT);
  }
  return { version: r.version, changed: r.toggled.length > 0 };
}

// --- Phase B: editing, validation and the Test box ---------------------------

/** A refused write: the HTTP status and the body to send. */
export class GuardrailWriteRefused extends Error {
  constructor(readonly status: number, readonly body: GuardrailWriteError) {
    super(body.error);
  }
}

export const REPAIR_HINT =
  "No guardrail can be written until the set verifies again. Find out what changed it (the audit trail, guardrail.integrity.failed), then have the owner run slaude guardrails import --repair <dir> on the host to re-sign it.";

/** A blocking parse problem refuses the write (the same rule as /deploy and import). */
function checkText(slug: string, md: string): void {
  if (!GUARDRAIL_SLUG_RE.test(slug)) throw new GuardrailWriteRefused(422, { error: `invalid guardrail name '${slug.slice(0, 64)}' (lowercase letters, digits and dashes)`, code: "invalid" });
  if (RESERVED_SLUGS.has(slug)) throw new GuardrailWriteRefused(422, { error: `'${slug}' is reserved; choose another guardrail name`, code: "invalid" });
  const p = parseGuardrail(slug, md);
  if (p.blocking.length) {
    throw new GuardrailWriteRefused(422, { error: `guardrail '${slug}' refused: ${p.blocking.join("; ")}`, code: "invalid", blocking: p.blocking, errors: p.errors });
  }
}

/** applyGuardrailChange with its refusals mapped to HTTP answers. */
async function write(change: GuardrailChange): Promise<ChangeResult> {
  try {
    return await applyGuardrailChange(TENANT, change);
  } catch (e) {
    if (e instanceof StaleGuardrailError) {
      const exists = e.expected === null && e.current !== null;
      throw new GuardrailWriteRefused(409, {
        error: exists ? e.message : `${e.message}. Reload it and apply your change again.`,
        code: exists ? "exists" : "stale",
        revision: e.current,
      });
    }
    if (e instanceof UnknownGuardrailError) throw new GuardrailWriteRefused(404, { error: e.message });
    if (e instanceof GuardrailIntegrityError) throw new GuardrailWriteRefused(423, { error: e.message, code: "integrity", hint: REPAIR_HINT });
    throw e;
  }
}

/** The verified stored set a write is planned on; a set that does not verify refuses every write. */
async function storedForWrite() {
  const { snap, failure } = await snapshot();
  if (!snap || failure) throw new GuardrailWriteRefused(423, { error: failure ?? "guardrails could not be read", code: "integrity", hint: REPAIR_HINT });
  return snap.stored;
}

function revisionAfter(r: ChangeResult, slug: string, prev: number | null): number | null {
  const touched = [...r.created, ...r.updated, ...r.overrideSet, ...r.overrideCleared].includes(slug);
  return touched ? r.version : prev;
}

/** After a write that changed something: audited (no text) and the snapshot re-read. */
async function afterWrite(r: ChangeResult, operatorId: string): Promise<void> {
  auditChange(r, { tenantId: TENANT, actorKind: "operator", actorId: operatorId, via: "console" });
  await refreshGuardrails(TENANT);
}

export async function createGuardrail(slug: string, md: string, operatorId: string): Promise<GuardrailWriteResponse> {
  checkText(slug, md);
  const r = await write({ upsert: [{ slug, md, source: "console" }], expect: [{ slug, revision: null }], by: operatorId });
  await afterWrite(r, operatorId);
  return { ok: true, slug, change: "created", revision: r.version, version: r.version };
}

/**
 * Edit a guardrail's text. A console guardrail's own row changes; a file or
 * git one gets (or replaces) a console override with base_sha the source's,
 * so a later sync that changes the source shows it behind source.
 */
export async function editGuardrail(slug: string, md: string, revision: number, operatorId: string): Promise<GuardrailWriteResponse> {
  checkText(slug, md);
  const row = (await storedForWrite()).rows.find((x) => x.slug === slug);
  if (!row) throw new GuardrailWriteRefused(404, { error: `no guardrail named '${slug}'` });
  const expect = [{ slug, revision }];
  const r = row.source === "console"
    ? await write({ upsert: [{ slug, md, source: "console" }], expect, by: operatorId })
    : await write({ setOverride: [{ slug, md }], expect, by: operatorId });
  const changed = r.created.length + r.updated.length + r.overrideSet.length > 0;
  if (changed) await afterWrite(r, operatorId);
  return { ok: true, slug, change: !changed ? "unchanged" : row.source === "console" ? "updated" : "override.set", revision: revisionAfter(r, slug, revision), version: r.version };
}

export async function clearGuardrailOverride(slug: string, revision: number, operatorId: string): Promise<GuardrailWriteResponse> {
  const stored = await storedForWrite();
  if (!stored.rows.some((x) => x.slug === slug)) throw new GuardrailWriteRefused(404, { error: `no guardrail named '${slug}'` });
  if (!stored.overrides.some((o) => o.slug === slug)) throw new GuardrailWriteRefused(404, { error: `guardrail '${slug}' has no console override`, code: "no-override" });
  const r = await write({ clearOverride: [slug], expect: [{ slug, revision }], by: operatorId });
  await afterWrite(r, operatorId);
  const s = (await snapshot()).snap?.stored;
  return { ok: true, slug, change: "override.cleared", revision: guardrailRevision(s?.rows.find((x) => x.slug === slug), undefined), version: r.version };
}

export async function deleteGuardrail(slug: string, revision: number, operatorId: string): Promise<GuardrailWriteResponse> {
  const row = (await storedForWrite()).rows.find((x) => x.slug === slug);
  if (!row) throw new GuardrailWriteRefused(404, { error: `no guardrail named '${slug}'` });
  if (row.source !== "console") {
    throw new GuardrailWriteRefused(422, {
      error: `guardrail '${slug}' comes from ${row.source === "git" ? "the deploy repo" : "host files"} and cannot be deleted from the console; switch it off here, or remove it at its source`,
      code: "not-deletable",
    });
  }
  const r = await write({ remove: [slug], expect: [{ slug, revision }], by: operatorId });
  await afterWrite(r, operatorId);
  return { ok: true, slug, change: "deleted", revision: null, version: r.version };
}

/** The editor's live check: the server's own parser, the agents it names, the prose cap with this draft saved. */
export async function validateGuardrailDraft(slug: string, md: string, deps: GuardrailApiDeps): Promise<GuardrailValidation> {
  const p = parseGuardrail(slug, md);
  const errors = [...p.errors];
  const blocking = [...p.blocking];
  if (!GUARDRAIL_SLUG_RE.test(slug)) blocking.unshift(`invalid guardrail name '${slug.slice(0, 64)}' (lowercase letters, digits and dashes)`);
  else if (RESERVED_SLUGS.has(slug)) blocking.unshift(`'${slug}' is reserved; choose another guardrail name`);
  for (const b of blocking) if (!errors.includes(b)) errors.unshift(b);
  const agents = deps.agents();
  const { snap } = await snapshot();
  const version = snap?.version ?? 0;
  const { resolved } = withDraft(snap?.resolved ?? [], { slug, md });
  const g = resolved.find((x) => x.slug === slug)!;
  const max = env.guardrailProseMax();
  const overCap: GuardrailValidation["prose"]["overCap"] = [];
  const appliesTo = agents.filter((a) => appliesToAgent(g, a));
  for (const a of appliesTo) {
    const sg = sessionGuardrails(resolved, a, null, { version, proseMax: max });
    if (sg.skipped.length) overCap.push({ agent: a, chars: sg.proseChars + sg.skipped.reduce((n, x) => n + x.chars, 0), skipped: sg.skipped });
  }
  const m = p.meta;
  return {
    slug,
    ok: blocking.length === 0,
    errors,
    blocking,
    name: m?.name ?? null,
    description: m?.description ?? "",
    scope: m?.scope ?? null,
    load: m?.load ?? null,
    rules: p.rules.map(ruleView),
    unknownAgents: m?.scope === "agents" ? m.agents.filter((a) => !agents.includes(a)) : [],
    appliesTo,
    prose: { chars: m?.load === "always" ? p.prose.length : 0, max, overCap },
  };
}

/** The Test box: one event through `agent`'s effective set in `channel`. No side effect but a guardrail.tested row without the text. */
export async function testGuardrails(req: GuardrailTestRequest, operatorId: string): Promise<GuardrailTestResponse> {
  const { snap, failure } = await snapshot();
  if (!snap) throw new GuardrailWriteRefused(423, { error: failure ?? "guardrails could not be read", code: "integrity", hint: REPAIR_HINT });
  let event: TestEvent;
  if (req.kind === "tool") {
    let input: unknown = {};
    if (req.input && req.input.trim()) {
      try {
        input = JSON.parse(req.input);
      } catch (e) {
        throw new GuardrailWriteRefused(400, { error: `the tool input is not valid JSON (${(e as Error).message})` });
      }
    }
    event = { kind: "tool", tool: req.tool ?? "", input };
  } else if (req.kind === "reply") {
    // Formatted as a real reply is before the reply rules run.
    event = { kind: "reply", text: formatOutbound(req.text ?? "", "reply", req.agent) };
  } else {
    event = { kind: "inbound", text: req.text ?? "" };
  }
  const r = evaluateGuardrails(snap.resolved, event, {
    agent: req.agent,
    channel: req.channel || null,
    version: snap.version,
    proseMax: env.guardrailProseMax(),
    draft: req.draft ?? null,
  });
  emitAudit({
    tenantId: TENANT,
    consoleWide: true,
    actorKind: "operator",
    actorId: operatorId,
    action: "guardrail.tested",
    targetKind: "guardrails",
    targetId: TENANT,
    summary: `guardrails tested: a ${req.kind === "tool" ? "tool call" : req.kind === "reply" ? "reply" : "message"} for ${req.agent}`,
    details: {
      agent: req.agent,
      kind: req.kind,
      ...(req.channel ? { channel: req.channel } : {}),
      ...(req.kind === "tool" ? { tool: req.tool } : {}),
      ...(req.draft ? { draft: req.draft.slug } : {}),
      decision: r.decision?.action ?? "none",
    },
  });
  return r;
}
