/**
 * Domain-record reconciler (slice B, task 4): an idempotent backfill and
 * repair, not a migration step. It runs at gateway boot after Slack auth and
 * as `slaude domain reconcile [--dry-run]`.
 *
 * Sources, in order:
 *   1. accounts: user, verified oidc binding, verified email binding (email
 *      normalised by the src/refs rule). Two accounts with one normalised
 *      email: the oldest keeps the binding, the other gets none and is listed
 *      as a conflict. Nothing is merged.
 *   2. slack_identities: verified slack binding on the account's user.
 *   3. Slack ids not yet bound: grant user subjects (declared), grant channel
 *      subjects (boundary, declared), session channels (boundary, observed;
 *      D-prefixed ids are dms), audit actors of kind slack_user (observed).
 *      Grid ids (W...) and workspace subjects are skipped and counted.
 *
 * Workspace per tenant: Postgres from that tenant's slack_apps rows, sqlite
 * from the resolver the caller passes (`liveTeamIds`). A session row carries
 * its own team id; a row without one, a grant and an audit actor are
 * attributed only when the tenant has exactly one workspace (otherwise
 * counted as `ambiguous`, or `no_workspace` when it has none). A Slack record
 * is never written with workspace ''.
 *
 * Safe to rerun and to race: every write is the repo's insert-or-ignore, a
 * Postgres advisory lock serialises runners, and an in-process queue
 * serialises runs sharing one connection. A non-dry run writes one summary
 * audit event (`domain.reconciled`) and no per-row events.
 */
import { audit, type AuditInput } from "../audit/index";
import * as Domain from "../db/domain";
import { normaliseEmail, projectLink, projectLogin, userForAccount } from "../db/account-projection";
import { db as globalDb, type DbClient } from "../db/schema";

export const RECONCILE_LOCK_KEY: [number, number] = [0x534c4155, 2];
const LOCK_TIMEOUT_MS = 5 * 60_000;
const SUMMARY_ACTION = "domain.reconciled";

export interface SourceReport {
  /** Records written (would be written in a dry run). */
  created: number;
  /** Rows already in place. */
  existing: number;
  /** Rows left alone, by reason. */
  skipped: Record<string, number>;
}

export interface Conflict {
  kind: "email" | "slack";
  accountId: string;
  /** The user that holds the value (ids only, never the value). */
  heldByUserId?: string;
  /** Dry run only: the earlier account in this run that would take the value. */
  heldByAccountId?: string;
}

export interface ReconcileReport {
  dryRun: boolean;
  sources: {
    accounts: SourceReport;
    slackIdentities: SourceReport;
    grantUsers: SourceReport;
    grantChannels: SourceReport;
    sessionChannels: SourceReport;
    auditActors: SourceReport;
  };
  /** Rows skipped because a Slack-shaped id is out of scope (Grid ids, workspace subjects), all sources. */
  conflicts: Conflict[];
  startedAt: number;
  finishedAt: number;
}

export interface ReconcileOptions {
  dryRun?: boolean;
  /** Defaults to the process facade. */
  db?: DbClient;
  /** sqlite: the workspace(s) the live Slack auth reports. Postgres reads slack_apps instead. */
  liveTeamIds?: () => Promise<string[]> | string[];
  /** Summary audit writer; defaults to the audit module. */
  audit?: (input: AuditInput) => Promise<void>;
  /** Skip the lock and the in-process queue (tests of the insert-or-ignore path). */
  unlocked?: boolean;
  log?: (msg: string) => void;
}

const empty = (): SourceReport => ({ created: 0, existing: 0, skipped: {} });
const skip = (s: SourceReport, reason: string) => {
  s.skipped[reason] = (s.skipped[reason] ?? 0) + 1;
};

const USER_RE = /^U[A-Z0-9]+$/;
const BOUNDARY_RE = /^[CGD][A-Z0-9]+$/;
const DEFAULT_TENANT = "default";

let queue: Promise<unknown> = Promise.resolve();

/** Run a reconcile. Throws only on an unexpected database failure; per-row oddities are reported. */
export async function reconcile(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  if (opts.unlocked) return run(opts);
  // In-process queue first: one connection (sqlite, PGLite) must not interleave two runs.
  const prev = queue;
  let release!: () => void;
  queue = new Promise<void>((r) => (release = r));
  await prev.catch(() => {});
  let unlock: (() => Promise<void>) | undefined;
  try {
    const c = opts.db ?? globalDb;
    if (c.advisoryLock) {
      unlock = await c.advisoryLock(...RECONCILE_LOCK_KEY, {
        onWait: () => opts.log?.("domain reconcile: waiting for another runner"),
        timeoutMs: LOCK_TIMEOUT_MS,
      });
    }
    return await run(opts);
  } finally {
    await unlock?.().catch(() => {});
    release();
  }
}

async function run(opts: ReconcileOptions): Promise<ReconcileReport> {
  const c = opts.db ?? globalDb;
  const dry = !!opts.dryRun;
  const startedAt = Date.now();
  const pg = c.dialect === "pg";
  const T = pg ? "tenant_id" : `'${DEFAULT_TENANT}'`;
  const report: ReconcileReport = {
    dryRun: dry,
    sources: {
      accounts: empty(),
      slackIdentities: empty(),
      grantUsers: empty(),
      grantChannels: empty(),
      sessionChannels: empty(),
      auditActors: empty(),
    },
    conflicts: [],
    startedAt,
    finishedAt: startedAt,
  };

  // Workspaces per tenant.
  const workspaces = new Map<string, Set<string>>();
  const addWs = (tenant: string, team: string) => {
    if (!team) return;
    const s = workspaces.get(tenant) ?? new Set<string>();
    s.add(team);
    workspaces.set(tenant, s);
  };
  if (pg) {
    for (const r of await c.query<{ tenant_id: string; team_id: string }>("SELECT DISTINCT tenant_id, team_id FROM slack_apps")) addWs(r.tenant_id, r.team_id);
  } else if (opts.liveTeamIds) {
    for (const t of await opts.liveTeamIds()) addWs(DEFAULT_TENANT, t);
  }
  /** The workspace a row without its own team id belongs to, or the reason it cannot be placed. */
  const place = (tenant: string): { ws: string } | { reason: "ambiguous" | "no_workspace" } => {
    const s = workspaces.get(tenant);
    if (!s || s.size === 0) return { reason: "no_workspace" };
    if (s.size > 1) return { reason: "ambiguous" };
    return { ws: [...s][0]! };
  };

  const inTx = <T2>(fn: (tx: DbClient) => Promise<T2>) => c.transaction(fn);
  /** Keys written or planned in this run, so a second source naming the same id counts as existing. */
  const seen = new Set<string>();

  // 1. accounts
  const accUser = new Map<string, string | null>(); // account id -> user id (null: dry run, not created yet)
  const plannedEmail = new Map<string, string>(); // normalised email -> account id (dry run)
  const accounts = await c.query<{ id: string; issuer: string; subject: string; email: string }>(
    "SELECT id, issuer, subject, email FROM accounts ORDER BY created_at, id",
  );
  const rA = report.sources.accounts;
  for (const a of accounts) {
    const mail = normaliseEmail(a.email);
    if (mail === null) skip(rA, "bad_email");
    const userId = await userForAccount(a, c);
    const emailHeld = mail ? await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: mail }, c) : null;
    const complete = userId !== null && (mail === null || (emailHeld?.user_id === userId && emailHeld.state === "verified"));
    if (complete) {
      rA.existing++;
      accUser.set(a.id, userId);
      continue;
    }
    if (dry) {
      const other = mail ? plannedEmail.get(mail) : undefined;
      let conflict: Conflict | null = null;
      if (mail && other && other !== a.id) conflict = { kind: "email", accountId: a.id, heldByAccountId: other };
      else if (mail && emailHeld && emailHeld.user_id !== userId && (await hasVerified(c, emailHeld.user_id))) {
        conflict = { kind: "email", accountId: a.id, heldByUserId: emailHeld.user_id };
      }
      if (conflict) {
        report.conflicts.push(conflict);
        skip(rA, "email_conflict");
      } else if (mail) plannedEmail.set(mail, a.id);
      if (userId === null || !conflict) rA.created++;
      else rA.existing++;
      accUser.set(a.id, userId);
      continue;
    }
    const events = await inTx((tx) => projectLogin({ issuer: a.issuer, subject: a.subject, email: a.email, previousEmail: null }, tx));
    void events;
    const u = await userForAccount(a, c);
    accUser.set(a.id, u);
    const after = mail ? await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: mail }, c) : null;
    if (u && mail && after && after.user_id !== u) {
      report.conflicts.push({ kind: "email", accountId: a.id, heldByUserId: after.user_id });
      skip(rA, "email_conflict");
      userId === null ? rA.created++ : rA.existing++;
    } else if (u === null) {
      skip(rA, "projection_failed");
    } else rA.created++;
  }

  // 2. slack_identities
  const rS = report.sources.slackIdentities;
  const idents = await c.query<{ team_id: string; slack_user_id: string; account_id: string }>(
    "SELECT team_id, slack_user_id, account_id FROM slack_identities ORDER BY linked_at, team_id, slack_user_id",
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const s of idents) {
    const a = byId.get(s.account_id);
    if (!a) {
      skip(rS, "no_account");
      continue;
    }
    if (!s.team_id) {
      skip(rS, "no_workspace");
      continue;
    }
    const key = { service: "slack", kind: "user", workspace: s.team_id, value: s.slack_user_id };
    const userId = accUser.get(a.id) ?? null;
    const held = await Domain.findBinding(key, c);
    seen.add(bk(key));
    if (held && held.state === "verified" && userId !== null && held.user_id === userId) {
      rS.existing++;
      continue;
    }
    if (dry) {
      if (held && held.user_id !== userId && (await hasVerified(c, held.user_id))) {
        report.conflicts.push({ kind: "slack", accountId: a.id, heldByUserId: held.user_id });
        skip(rS, "conflict");
      } else rS.created++;
      continue;
    }
    if (userId === null) {
      skip(rS, "no_user");
      continue;
    }
    await inTx((tx) => projectLink({ issuer: a.issuer, subject: a.subject, teamId: s.team_id, slackUserId: s.slack_user_id }, tx));
    const after = await Domain.findBinding(key, c);
    if (after && after.user_id === userId && after.state === "verified") rS.created++;
    else {
      report.conflicts.push({ kind: "slack", accountId: a.id, ...(after ? { heldByUserId: after.user_id } : {}) });
      skip(rS, "conflict");
    }
  }

  // 3. Slack ids not yet bound.
  const ensureUserBinding = async (rep: SourceReport, ws: string, value: string, state: Domain.State, source: string) => {
    const key = { service: "slack", kind: "user", workspace: ws, value };
    const k = bk(key);
    const held = seen.has(k) ? true : !!(await Domain.findBinding(key, c));
    seen.add(k);
    if (dry) {
      held ? rep.existing++ : rep.created++;
      return;
    }
    const r = await inTx((tx) => Domain.ensureBinding({ ...key, state, source }, tx));
    r.created ? rep.created++ : rep.existing++;
  };
  const ensureBoundaryRecord = async (rep: SourceReport, ws: string, value: string, state: Domain.State) => {
    const key = { service: "slack", workspace: ws, value };
    const k = `boundary\0${key.workspace}\0${key.value}`;
    const held = seen.has(k) ? true : !!(await Domain.findBoundary(key, c));
    seen.add(k);
    if (dry) {
      held ? rep.existing++ : rep.created++;
      return;
    }
    const kind = value.startsWith("D") ? "dm" : "channel";
    const r = await inTx((tx) => Domain.ensureBoundary({ ...key, kind, state }, tx));
    r.created ? rep.created++ : rep.existing++;
  };
  const userId = (rep: SourceReport, raw: string): boolean => {
    if (raw.startsWith("W")) return skip(rep, "grid"), false;
    if (!USER_RE.test(raw)) return skip(rep, "not_slack_id"), false;
    return true;
  };

  const rGU = report.sources.grantUsers;
  for (const g of await c.query<{ tenant_id: string; subject_id: string }>(
    `SELECT DISTINCT ${T} AS tenant_id, subject_id FROM agent_grants WHERE subject_kind = 'user' ORDER BY 1, 2`,
  )) {
    if (!userId(rGU, g.subject_id)) continue;
    const p = place(g.tenant_id);
    if ("reason" in p) skip(rGU, p.reason);
    else await ensureUserBinding(rGU, p.ws, g.subject_id, "declared", "grant");
  }

  const rGC = report.sources.grantChannels;
  const wsSubjects = await c.one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_grants WHERE subject_kind = 'workspace'");
  if (Number(wsSubjects?.n ?? 0) > 0) rGC.skipped.workspace_subject = Number(wsSubjects!.n);
  for (const g of await c.query<{ tenant_id: string; subject_id: string }>(
    `SELECT DISTINCT ${T} AS tenant_id, subject_id FROM agent_grants WHERE subject_kind = 'channel' ORDER BY 1, 2`,
  )) {
    if (!BOUNDARY_RE.test(g.subject_id)) {
      skip(rGC, "not_slack_id");
      continue;
    }
    const p = place(g.tenant_id);
    if ("reason" in p) skip(rGC, p.reason);
    else await ensureBoundaryRecord(rGC, p.ws, g.subject_id, "declared");
  }

  const rSC = report.sources.sessionChannels;
  for (const s of await c.query<{ tenant_id: string; slack_team_id: string | null; slack_channel_id: string }>(
    `SELECT DISTINCT ${T} AS tenant_id, slack_team_id, slack_channel_id FROM sessions
     WHERE slack_channel_id IS NOT NULL AND slack_channel_id <> '' ORDER BY 1, 2, 3`,
  )) {
    if (!BOUNDARY_RE.test(s.slack_channel_id)) {
      skip(rSC, "not_slack_id");
      continue;
    }
    let ws = s.slack_team_id ?? "";
    if (!ws) {
      const p = place(s.tenant_id);
      if ("reason" in p) {
        skip(rSC, p.reason);
        continue;
      }
      ws = p.ws;
    }
    await ensureBoundaryRecord(rSC, ws, s.slack_channel_id, "observed");
  }

  const rAA = report.sources.auditActors;
  for (const e of await c.query<{ tenant_id: string; actor_id: string }>(
    `SELECT DISTINCT ${T} AS tenant_id, actor_id FROM audit_events WHERE actor_kind = 'slack_user' ORDER BY 1, 2`,
  )) {
    if (!userId(rAA, e.actor_id)) continue;
    const p = place(e.tenant_id);
    if ("reason" in p) skip(rAA, p.reason);
    else await ensureUserBinding(rAA, p.ws, e.actor_id, "observed", "audit");
  }

  report.finishedAt = Date.now();
  if (!dry) {
    const write = opts.audit ?? ((i: AuditInput) => audit(i));
    await write({
      actorKind: "system",
      actorId: "system",
      action: SUMMARY_ACTION,
      targetKind: "domain",
      summary: `domain reconcile: ${totalCreated(report)} record(s) created, ${report.conflicts.length} conflict(s)`,
      details: { ...report },
    }).catch((e) => console.warn(`[domain] reconcile summary audit failed: ${(e as Error).message}`));
  }
  return report;
}

const bk = (k: { service: string; kind: string; workspace: string; value: string }) => `binding\0${k.service}\0${k.kind}\0${k.workspace}\0${k.value}`;

async function hasVerified(c: DbClient, userId: string): Promise<boolean> {
  const r = await c.one<{ n: number }>("SELECT COUNT(*) AS n FROM bindings WHERE user_id = ? AND state = 'verified'", [userId]);
  return Number(r?.n ?? 0) > 0;
}

export function totalCreated(r: ReconcileReport): number {
  return Object.values(r.sources).reduce((n, s) => n + s.created, 0);
}

const LABELS: Record<keyof ReconcileReport["sources"], string> = {
  accounts: "accounts",
  slackIdentities: "slack identities",
  grantUsers: "grant users",
  grantChannels: "grant channels",
  sessionChannels: "session channels",
  auditActors: "audit actors",
};

/** The report as readable text. Ids only: no emails, no Slack values. */
export function formatReconcileReport(r: ReconcileReport): string {
  const verb = r.dryRun ? "would create" : "created";
  const lines = [`domain reconcile${r.dryRun ? " (dry run, nothing written)" : ""}`];
  for (const [key, label] of Object.entries(LABELS) as [keyof typeof LABELS, string][]) {
    const s = r.sources[key];
    const skipped = Object.entries(s.skipped).map(([k, n]) => `${k} ${n}`).join(", ");
    lines.push(`  ${label.padEnd(17)} ${verb} ${s.created}, existing ${s.existing}${skipped ? `, skipped (${skipped})` : ""}`);
  }
  if (r.conflicts.length === 0) lines.push("  conflicts: none");
  else {
    lines.push(`  conflicts: ${r.conflicts.length} (left for the console, nothing merged)`);
    for (const c of r.conflicts) {
      lines.push(`    ${c.kind} account=${c.accountId}${c.heldByUserId ? ` held-by-user=${c.heldByUserId}` : ""}${c.heldByAccountId ? ` held-by-account=${c.heldByAccountId}` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Gateway boot hook. Never throws and never blocks boot: call it with `void`.
 * A node has no database, so it does nothing there.
 */
export async function reconcileAtBoot(o: {
  role: string;
  liveTeamIds: () => Promise<string[]> | string[];
  run?: (opts: ReconcileOptions) => Promise<ReconcileReport>;
  log?: (msg: string) => void;
}): Promise<ReconcileReport | null> {
  if (o.role === "node") return null;
  const log = o.log ?? ((m: string) => console.log(`[domain] ${m}`));
  try {
    const r = await (o.run ?? reconcile)({ liveTeamIds: o.liveTeamIds, log });
    log(`reconcile done: ${totalCreated(r)} created, ${r.conflicts.length} conflict(s)\n${formatReconcileReport(r)}`);
    return r;
  } catch (e) {
    console.error(`[domain] reconcile failed (boot continues): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
