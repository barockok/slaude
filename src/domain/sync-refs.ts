/**
 * References a definition sync carries, and the declared records they create
 * (slice B, task 5). `collectRefs` reads every typed reference out of a
 * compiled persona; `planRefs` says, without writing, which records a sync
 * would create or refuse; `ensureRefs` creates them inside the sync
 * transaction. Slack short forms (the compiled form carries bare ids) mean the
 * tenant's one workspace; zero or several workspaces refuse them by persona
 * and field.
 *
 * A created record is `declared` and grants nothing. An existing record is
 * never changed (the repo never downgrades a state). Selectors create nothing;
 * an internal reference must already exist. Reports name a Slack reference as
 * written and an email or phone only masked, plus the record id once created.
 */
import * as Domain from "../db/domain";
import type { DomainEvent } from "../db/domain";
import { db as globalDb, type DbClient } from "../db/schema";
import { resolveRef } from "../refs/resolve";
import { formatRef } from "../refs/parse";
import type { Ref } from "../refs/types";
import { parseProactive } from "../soul/proactive";
import type { SoulData } from "../soul/data";

export interface RefUse {
  persona: string;
  /** The agent.yaml field, for messages (never the value). */
  field: string;
  ref: Ref;
}

export interface RecordEntry {
  type: "user" | "boundary";
  /** The reference as safe text: a Slack reference as written, an email or phone masked. */
  ref: string;
  /** The binding id (user) or boundary id, once created. */
  id?: string;
  state: "declared";
  personas: string[];
}

export class RefRefusal extends Error {}

const slackRef = (type: "user" | "channel", id: string, workspace?: string): Ref => ({ kind: "external", service: "slack", type: type, id, ...(workspace ? { workspace } : {}) });

/** Every reference a compiled persona carries. Ids that are not Slack-shaped are left to the compiler's own check. */
export function collectRefs(persona: string, soul: SoulData, soulText: string): RefUse[] {
  const out: RefUse[] = [];
  const add = (field: string, ref: Ref) => out.push({ persona, field, ref });
  // The compiled arrays carry bare ids; `accessEntries` remembers the workspace the author wrote. An id written
  // with two different workspaces is left bare (it then needs the tenant's single workspace, or is refused).
  const written = new Map<string, string | null>();
  for (const e of soul.accessEntries ?? []) {
    const k = `${e.kind}:${e.id}`;
    const w = e.workspace ?? null;
    written.set(k, !written.has(k) || written.get(k) === w ? w : null);
  }
  const bareUser = (id: string): Ref => slackRef("user", id, written.get(`user:${id}`) ?? undefined);
  const bareChannel = (id: string): Ref => slackRef("channel", id, written.get(`channel:${id}`) ?? undefined);
  if (soul.manager?.userId) add("access.manager", bareUser(soul.manager.userId));
  if (soul.backupManager?.userId) add("access.backupManager", bareUser(soul.backupManager.userId));
  soul.approvers?.forEach((a, i) => add(`access.approvers[${i}].user`, bareUser(a.userId)));
  soul.allowedChannels?.forEach((c, i) => add(`access.channels.public[${i}]`, bareChannel(c)));
  soul.trustedChannels?.forEach((c, i) => add(`access.channels.trusted[${i}]`, bareChannel(c)));
  soul.blockedUsers?.forEach((u, i) => add(`access.blocked[${i}]`, bareUser(u)));
  soul.dmAllowedUsers?.forEach((u, i) => add(`access.dm[${i}]`, bareUser(u)));
  // `email:` and `user:` references (only compiled while the access source is `internal`): the same declared records, nothing granted by them.
  soul.accessRefs?.forEach((r, i) => add(`access.${r.field} (reference ${i})`, r.ref.service === "email" ? { kind: "email", address: r.ref.address } : { kind: "internal", type: "user", id: r.ref.userId }));
  soul.channelOverrides?.forEach((o, i) => {
    add(`mandate.scoped / channels (channel ${i})`, bareChannel(o.channel));
    o.approvers?.forEach((a, j) => add(`access.approvers (channel ${i}, entry ${j})`, bareUser(a.userId)));
  });
  try {
    const p = parseProactive(soulText);
    p.read.forEach((c, i) => add(`proactive.read[${i}]`, bareChannel(c)));
    const keys = new Set([...Object.keys(p.channels), ...Object.keys(p.sessions), ...p.invalidSessions]);
    for (const c of keys) add("channels", bareChannel(c));
  } catch {
    // A soul the proactive parser cannot read has no proactive references to carry.
  }
  return out.filter((u) => u.ref.kind !== "external" || /^[A-Z0-9]+$/.test(u.ref.id));
}

/** The workspaces a tenant's Slack apps are installed in. Postgres only (sync is). */
export async function tenantWorkspaces(tenant: string, c: DbClient = globalDb): Promise<string[]> {
  const rows = await c.query<{ team_id: string }>("SELECT DISTINCT team_id FROM slack_apps WHERE tenant_id = ? ORDER BY team_id", [tenant]);
  return rows.map((r) => r.team_id).filter(Boolean);
}

let singleCache: { until: number; v: string | undefined } | null = null;
/** Forget the cached answer of {@link singleWorkspace} (tests). */
export function __resetSingleWorkspace(): void {
  singleCache = null;
}
/**
 * The deployment's one connected workspace, or undefined when it has none or
 * several (the same single-workspace rule as sync and the reconciler). Postgres
 * reads the tenant's slack_apps; sqlite the workspace its Slack bindings are in.
 * Cached for 30 s; a read error is undefined.
 */
export async function singleWorkspace(c: DbClient = globalDb): Promise<string | undefined> {
  if (singleCache && Date.now() < singleCache.until) return singleCache.v;
  let v: string | undefined;
  try {
    const ws = c.dialect === "pg"
      ? await tenantWorkspaces("default", c)
      : (await c.query<{ workspace: string }>("SELECT DISTINCT workspace FROM bindings WHERE service = 'slack' AND kind = 'user' AND workspace <> '' LIMIT 3")).map((r) => r.workspace);
    v = ws.length === 1 ? ws[0] : undefined;
  } catch {
    v = undefined;
  }
  singleCache = { until: Date.now() + 30_000, v };
  return v;
}

/** The workspace for each use, or a refusal naming persona and field. */
function placed(uses: RefUse[], workspaces: string[]): Array<{ use: RefUse; workspace: string }> {
  return uses.map((use) => {
    const r = use.ref;
    if (r.kind === "external" && r.service === "slack") {
      if (r.workspace) return { use, workspace: r.workspace };
      if (workspaces.length === 1) return { use, workspace: workspaces[0]! };
      const why = workspaces.length === 0
        ? "this tenant has no Slack workspace connected, so a short Slack reference has no workspace to mean"
        : `this tenant has ${workspaces.length} Slack workspaces, so a short Slack reference is ambiguous; write it with its workspace (slack:user:T.../<id>)`;
      throw new RefRefusal(`persona '${use.persona}': ${use.field} is a Slack reference without a workspace and ${why}`);
    }
    return { use, workspace: "" };
  });
}

type Target =
  | { type: "user"; key: Domain.BindingKey; label: string; internal?: undefined }
  | { type: "boundary"; key: Domain.BoundaryKey & { kind: string }; label: string; internal?: undefined }
  | { type: "internal"; ref: Extract<Ref, { kind: "internal" }>; label: string };

const mask = (s: string) => `***${s.slice(-4)}`;
export function safeRef(ref: Ref, workspace?: string): string {
  switch (ref.kind) {
    case "email": return `email:***@${ref.address.slice(ref.address.indexOf("@") + 1)}`;
    case "external":
      if (ref.service === "slack") return formatRef({ ...ref, workspace: ref.workspace ?? workspace });
      return ref.type === "phone" ? `${ref.service}:phone:${mask(ref.id)}` : `${ref.service}:${ref.type}:${ref.id}`;
    default: return formatRef(ref);
  }
}

function targetOf(ref: Ref, workspace: string): Target | null {
  const label = safeRef(ref, workspace);
  switch (ref.kind) {
    case "selector": return null;
    case "email": return { type: "user", label, key: { service: "email", kind: "address", workspace: "", value: ref.address } };
    case "internal":
      return ref.type === "user" || ref.type === "boundary" ? { type: "internal", ref, label } : null;
    case "external":
      if (ref.type === "user") return { type: "user", label, key: { service: ref.service, kind: "user", workspace: ref.service === "slack" ? workspace : "", value: ref.id } };
      if (ref.type === "phone") return { type: "user", label, key: { service: ref.service, kind: "phone", workspace: "", value: ref.id } };
      if (ref.service === "slack") return { type: "boundary", label, key: { service: "slack", workspace, value: ref.id, kind: ref.id.startsWith("D") ? "dm" : "channel" } };
      return { type: "boundary", label, key: { service: ref.service, workspace: "", value: ref.id, kind: "group" } };
  }
}

const targetKey = (t: Target) =>
  t.type === "internal" ? `internal\0${t.ref.type}\0${t.ref.id}`
  : t.type === "user" ? `u\0${t.key.service}\0${t.key.kind}\0${t.key.workspace}\0${t.key.value}`
  : `b\0${t.key.service}\0${t.key.workspace}\0${t.key.value}`;

function targets(uses: RefUse[], workspaces: string[]): Array<{ t: Target; uses: RefUse[] }> {
  const by = new Map<string, { t: Target; uses: RefUse[] }>();
  for (const { use, workspace } of placed(uses, workspaces)) {
    const t = targetOf(use.ref, workspace);
    if (!t) continue;
    const k = targetKey(t);
    const e = by.get(k);
    if (e) e.uses.push(use);
    else by.set(k, { t, uses: [use] });
  }
  return [...by.values()];
}

const personasOf = (uses: RefUse[]) => [...new Set(uses.map((u) => u.persona))].sort();

async function internalExists(ref: Extract<Ref, { kind: "internal" }>, tx?: DbClient): Promise<boolean> {
  return !!(await resolveRef(ref, { tx })).record;
}
const missingInternal = (uses: RefUse[]) =>
  `persona '${uses[0]!.persona}': ${uses[0]!.field} names an internal record that does not exist; create it first or reference it another way`;

/** What a sync would create, without writing. Throws RefRefusal for what it would refuse. */
export async function planRefs(uses: RefUse[], workspaces: string[], c?: DbClient): Promise<RecordEntry[]> {
  const out: RecordEntry[] = [];
  for (const { t, uses: us } of targets(uses, workspaces)) {
    if (t.type === "internal") {
      if (!(await internalExists(t.ref, c))) throw new RefRefusal(missingInternal(us));
    } else if (t.type === "user") {
      if (!(await Domain.findBinding(t.key, c))) out.push({ type: "user", ref: t.label, state: "declared", personas: personasOf(us) });
    } else if (!(await Domain.findBoundary(t.key, c))) {
      out.push({ type: "boundary", ref: t.label, state: "declared", personas: personasOf(us) });
    }
  }
  return out;
}

/** Create what is missing, inside the sync transaction. Returns what was created and the events to emit after commit. */
export async function ensureRefs(uses: RefUse[], workspaces: string[], tx: DbClient): Promise<{ created: RecordEntry[]; events: DomainEvent[] }> {
  const created: RecordEntry[] = [];
  const events: DomainEvent[] = [];
  for (const { t, uses: us } of targets(uses, workspaces)) {
    if (t.type === "internal") {
      if (!(await internalExists(t.ref, tx))) throw new RefRefusal(missingInternal(us));
    } else if (t.type === "user") {
      const r = await Domain.ensureBinding({ ...t.key, state: "declared", source: "sync" }, tx);
      if (r.created) created.push({ type: "user", ref: t.label, id: r.binding.id, state: "declared", personas: personasOf(us) });
      events.push(...r.events);
    } else {
      const r = await Domain.ensureBoundary({ ...t.key, state: "declared" }, tx);
      if (r.created) created.push({ type: "boundary", ref: t.label, id: r.boundary.id, state: "declared", personas: personasOf(us) });
      events.push(...r.events);
    }
  }
  return { created, events };
}
