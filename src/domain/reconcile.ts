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
 * The Slack-id sources are read in keyset pages (PAGE_SIZE): each page selects
 * the distinct ids with a LEFT JOIN to the bound record in the tenant's
 * workspace, and writes the missing ones in one transaction per page with the
 * repo's insert-or-ignore. A fully reconciled boot costs one read per page and
 * no transaction. Audit actors are walked through idx_audit_events_actor_kind.
 *
 * 4. Unproven email bindings (slice C, D16). A verified email binding is
 *    "proven" only when an account whose last login proved its address
 *    (accounts.email_proven) sits on the same user and carries that address.
 *    Every other verified email binding (all of them from before rc.19) is
 *    counted per issuer in the report. Every run reports; none changes a state
 *    unless the caller passes `demoteUnprovenEmails` (the CLI, explicitly), in
 *    which case they go back to observed. The boot hook never passes it.
 *
 * Safe to rerun and to race: every write is the repo's insert-or-ignore, a
 * Postgres advisory lock serialises runners, and an in-process queue
 * serialises runs sharing one connection. A non-dry run that created something
 * or found a conflict writes one summary audit event (`domain.reconciled`) and
 * no per-row events; a no-op run writes none.
 */
import { audit, type AuditInput } from "../audit/index";
import * as Domain from "../db/domain";
import { normaliseEmail, projectLink, projectLogin, userForAccount } from "../db/account-projection";
import { purgeExpiredLinkTokens } from "../db/link-token-uses";
import { db as globalDb, type DbClient } from "../db/schema";

export const RECONCILE_LOCK_KEY: [number, number] = [0x534c4155, 2];
export const PAGE_SIZE = 500;
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

export interface UnprovenEmails {
  total: number;
  /** Issuer (or "(no account)" when the user holds no oidc binding) to count. */
  byIssuer: Record<string, number>;
  /** Bindings set back to observed by this run (0 unless demotion was asked for and this is not a dry run). */
  demoted: number;
}

export const NO_ACCOUNT = "(no account)";

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
  /** Expired link token ledger rows removed (would be, in a dry run). */
  linkTokensPurged: number;
  /** Verified email bindings no proving login backs, per issuer of the user's oidc binding; counts only, never an address. */
  unprovenEmails: UnprovenEmails;
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
  /** Rows per page of the Slack-id sources (default PAGE_SIZE). */
  pageSize?: number;
  /**
   * Set verified email bindings that no proving login backs back to observed.
   * Off by default and never set by the boot hook; ignored in a dry run.
   */
  demoteUnprovenEmails?: boolean;
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
    linkTokensPurged: 0,
    unprovenEmails: { total: 0, byIssuer: {}, demoted: 0 },
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
  const accounts = await c.query<{ id: string; issuer: string; subject: string; email: string; email_proven: boolean | number }>(
    "SELECT id, issuer, subject, email, email_proven FROM accounts ORDER BY created_at, id",
  );
  const rA = report.sources.accounts;
  for (const a of accounts) {
    const mail = normaliseEmail(a.email);
    if (mail === null) skip(rA, "bad_email");
    const userId = await userForAccount(a, c);
    const emailHeld = mail ? await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: mail }, c) : null;
    // An account whose last login proved the address needs a verified binding; one that did not (or predates
    // email_proven) needs the binding on its user in any state. A bound verified one is never lowered here.
    const proven = Boolean(a.email_proven);
    const complete =
      userId !== null && (mail === null || (emailHeld?.user_id === userId && (!proven || emailHeld.state === "verified")));
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
    const events = await inTx((tx) => projectLogin({ issuer: a.issuer, subject: a.subject, email: a.email, emailProven: proven, previousEmail: null }, tx));
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

  // 3. Slack ids not yet bound, in pages.
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const RANK: Record<Domain.State, number> = { declared: 0, observed: 1, verified: 2 };
  const tenantsOf = async (table: string, where: string): Promise<string[]> =>
    pg ? (await c.query<{ t: string }>(`SELECT DISTINCT tenant_id AS t FROM ${table} WHERE ${where} ORDER BY 1`)).map((r) => r.t) : [DEFAULT_TENANT];
  const tf = pg ? "AND tenant_id = ?" : "";
  const tp = (tenant: string): unknown[] => (pg ? [tenant] : []);

  interface Cand {
    team: string;
    v: string;
    bstate: Domain.State | null;
  }
  /**
   * Walk one source tenant by tenant. `fetch` returns one page after the cursor
   * (null: first page) with each row's current state in `ws` (null when absent);
   * rows whose id is out of scope or whose workspace cannot be placed are
   * counted as before; the rest are written one transaction per page.
   */
  async function walk(
    rep: SourceReport,
    kind: "user" | "boundary",
    tenants: string[],
    state: Domain.State,
    source: string,
    idOk: (rep: SourceReport, raw: string) => boolean,
    fetch: (tenant: string, ws: string | null, after: { team: string; v: string } | null) => Promise<Cand[]>,
  ): Promise<void> {
    for (const tenant of tenants) {
      const p = place(tenant);
      const tenantWs = "ws" in p ? p.ws : null;
      let after: { team: string; v: string } | null = null;
      for (;;) {
        const page = await fetch(tenant, tenantWs, after);
        if (page.length === 0) break;
        after = { team: page[page.length - 1]!.team, v: page[page.length - 1]!.v };
        const work: Array<{ ws: string; v: string }> = [];
        for (const row of page) {
          if (!idOk(rep, row.v)) continue;
          let ws = row.team;
          if (!ws) {
            if ("reason" in p) {
              skip(rep, p.reason);
              continue;
            }
            ws = p.ws;
          }
          const k = kind === "user" ? bk({ service: "slack", kind: "user", workspace: ws, value: row.v }) : `boundary\0${ws}\0${row.v}`;
          const known = seen.has(k) || row.bstate !== null;
          seen.add(k);
          if (dry) {
            known ? rep.existing++ : rep.created++;
          } else if (row.bstate !== null && RANK[row.bstate] >= RANK[state]) {
            rep.existing++;
          } else {
            work.push({ ws, v: row.v });
          }
        }
        if (work.length) {
          await inTx(async (tx) => {
            for (const w of work) {
              const created =
                kind === "user"
                  ? (await Domain.ensureBinding({ service: "slack", kind: "user", workspace: w.ws, value: w.v, state, source }, tx)).created
                  : (await Domain.ensureBoundary({ service: "slack", workspace: w.ws, value: w.v, kind: w.v.startsWith("D") ? "dm" : "channel", state }, tx)).created;
              created ? rep.created++ : rep.existing++;
            }
          });
        }
        if (page.length < pageSize) break;
      }
    }
  }
  const userId = (rep: SourceReport, raw: string): boolean => {
    if (raw.startsWith("W")) return skip(rep, "grid"), false;
    if (!USER_RE.test(raw)) return skip(rep, "not_slack_id"), false;
    return true;
  };
  const boundaryId = (rep: SourceReport, raw: string): boolean => (BOUNDARY_RE.test(raw) ? true : (skip(rep, "not_slack_id"), false));
  const JOIN_USER = "LEFT JOIN bindings b ON b.service = 'slack' AND b.kind = 'user' AND b.workspace = ? AND b.value = s.v";
  const JOIN_BOUNDARY = "LEFT JOIN boundaries b ON b.service = 'slack' AND b.workspace = ? AND b.value = s.v";
  const asCands = (rows: Array<{ team?: string; v: string; bstate: Domain.State | null }>): Cand[] =>
    rows.map((r) => ({ team: r.team ?? "", v: r.v, bstate: r.bstate ?? null }));

  const rGU = report.sources.grantUsers;
  await walk(
    rGU, "user", await tenantsOf("agent_grants", "subject_kind = 'user'"), "declared", "grant", userId,
    async (tenant, ws, after) =>
      asCands(
        await c.query(
          `SELECT s.v AS v, b.state AS bstate FROM (
             SELECT DISTINCT subject_id AS v FROM agent_grants
             WHERE subject_kind = 'user' ${tf} AND subject_id > ? ORDER BY 1 LIMIT ?) s
           ${JOIN_USER} ORDER BY s.v`,
          [...tp(tenant), after?.v ?? "", pageSize, ws],
        ),
      ),
  );

  const rGC = report.sources.grantChannels;
  const wsSubjects = await c.one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_grants WHERE subject_kind = 'workspace'");
  if (Number(wsSubjects?.n ?? 0) > 0) rGC.skipped.workspace_subject = Number(wsSubjects!.n);
  await walk(
    rGC, "boundary", await tenantsOf("agent_grants", "subject_kind = 'channel'"), "declared", "grant", boundaryId,
    async (tenant, ws, after) =>
      asCands(
        await c.query(
          `SELECT s.v AS v, b.state AS bstate FROM (
             SELECT DISTINCT subject_id AS v FROM agent_grants
             WHERE subject_kind = 'channel' ${tf} AND subject_id > ? ORDER BY 1 LIMIT ?) s
           ${JOIN_BOUNDARY} ORDER BY s.v`,
          [...tp(tenant), after?.v ?? "", pageSize, ws],
        ),
      ),
  );

  const rSC = report.sources.sessionChannels;
  await walk(
    rSC, "boundary", await tenantsOf("sessions", "slack_channel_id IS NOT NULL AND slack_channel_id <> ''"), "observed", "session", boundaryId,
    async (tenant, ws, after) =>
      asCands(
        await c.query(
          `SELECT s.team AS team, s.v AS v, b.state AS bstate FROM (
             SELECT DISTINCT COALESCE(slack_team_id, '') AS team, slack_channel_id AS v FROM sessions
             WHERE slack_channel_id IS NOT NULL AND slack_channel_id <> '' ${tf}
               AND (COALESCE(slack_team_id, ''), slack_channel_id) > (?, ?) ORDER BY 1, 2 LIMIT ?) s
           LEFT JOIN boundaries b ON b.service = 'slack' AND b.workspace = COALESCE(NULLIF(s.team, ''), ?) AND b.value = s.v
           ORDER BY s.team, s.v`,
          [...tp(tenant), after?.team ?? "", after?.v ?? "", pageSize, ws],
        ),
      ),
  );

  const rAA = report.sources.auditActors;
  await walk(
    rAA, "user", await tenantsOf("audit_events", "actor_kind = 'slack_user'"), "observed", "audit", userId,
    async (tenant, ws, after) =>
      asCands(
        await c.query(
          `SELECT s.v AS v, b.state AS bstate FROM (
             SELECT DISTINCT actor_id AS v FROM audit_events
             WHERE actor_kind = 'slack_user' ${tf} AND actor_id > ? ORDER BY 1 LIMIT ?) s
           ${JOIN_USER} ORDER BY s.v`,
          [...tp(tenant), after?.v ?? "", pageSize, ws],
        ),
      ),
  );

  // Link token ledger rows are dead once the token has expired. Housekeeping, so it neither
  // counts as a created record nor makes a run write a summary audit event.
  if (dry) {
    const n = await c.one<{ n: number | string }>("SELECT COUNT(*) AS n FROM link_token_uses WHERE expires_at <= ?", [Date.now()]);
    report.linkTokensPurged = Number(n?.n ?? 0);
  } else report.linkTokensPurged = await purgeExpiredLinkTokens(c);

  // 4. Unproven email bindings: reported on every run, demoted only on request.
  report.unprovenEmails = await unprovenEmailBindings(c, { demote: !!opts.demoteUnprovenEmails && !dry, pageSize: opts.pageSize ?? PAGE_SIZE });
  if (report.unprovenEmails.demoted > 0) {
    const write = opts.audit ?? ((i: AuditInput) => audit(i));
    await write({
      actorKind: "system",
      actorId: "system",
      action: "domain.emails_demoted",
      targetKind: "domain",
      summary: `domain reconcile: ${report.unprovenEmails.demoted} unproven email binding(s) set back to observed`,
      details: { demoted: report.unprovenEmails.demoted, byIssuer: report.unprovenEmails.byIssuer },
    }).catch((e) => console.warn(`[domain] email demotion audit failed: ${(e as Error).message}`));
  }

  report.finishedAt = Date.now();
  // A no-op run (nothing created, no conflict) stays silent: boot would otherwise add one audit row per start.
  if (!dry && (totalCreated(report) > 0 || report.conflicts.length > 0)) {
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

/**
 * Verified email bindings that no proving login backs. Read in keyset pages;
 * a demotion is a compare-and-set per row (still verified), so a binding a
 * login raised in between stays as it is. Only `verified` email bindings are
 * touched, and only down to observed: no other binding, user or state moves.
 */
export async function unprovenEmailBindings(c: DbClient, o: { demote: boolean; pageSize?: number }): Promise<UnprovenEmails> {
  const pageSize = o.pageSize ?? PAGE_SIZE;
  const out: UnprovenEmails = { total: 0, byIssuer: {}, demoted: 0 };
  // user id + normalised address pairs a proving account backs. Accounts are few; read them once.
  const proven = new Set<string>();
  const accts = await c.query<{ issuer: string; subject: string; email: string }>("SELECT issuer, subject, email FROM accounts WHERE email_proven = ?", [c.dialect === "pg" ? true : 1]);
  for (const a of accts) {
    const mail = normaliseEmail(a.email);
    const uid = await userForAccount(a, c);
    if (mail && uid) proven.add(`${uid}\0${mail}`);
  }
  let after = "";
  for (;;) {
    const page = await c.query<{ id: string; user_id: string; value: string }>(
      "SELECT id, user_id, value FROM bindings WHERE service = 'email' AND kind = 'address' AND state = 'verified' AND id > ? ORDER BY id LIMIT ?",
      [after, pageSize],
    );
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    const unproven = page.filter((b) => !proven.has(`${b.user_id}\0${b.value}`));
    if (unproven.length) {
      const users = [...new Set(unproven.map((b) => b.user_id))];
      const issuerOf = new Map<string, string>();
      for (const r of await c.query<{ user_id: string; workspace: string }>(
        `SELECT user_id, workspace FROM bindings WHERE service = 'oidc' AND kind = 'subject' AND user_id IN (${users.map(() => "?").join(",")}) ORDER BY created_at, id`,
        users,
      )) {
        if (!issuerOf.has(r.user_id)) issuerOf.set(r.user_id, r.workspace);
      }
      for (const b of unproven) {
        const issuer = issuerOf.get(b.user_id) ?? NO_ACCOUNT;
        out.total++;
        out.byIssuer[issuer] = (out.byIssuer[issuer] ?? 0) + 1;
        if (o.demote) {
          const r = await c.run(
            "UPDATE bindings SET state = 'observed', verified_at = NULL, updated_at = ? WHERE id = ? AND state = 'verified'",
            [Date.now(), b.id],
          );
          out.demoted += r.changes ?? 0;
        }
      }
    }
    if (page.length < pageSize) break;
  }
  return out;
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
  const u = r.unprovenEmails;
  if (u.total === 0) lines.push("  unproven email bindings: none");
  else {
    const per = Object.entries(u.byIssuer).map(([k, n]) => `${k} ${n}`).join(", ");
    lines.push(`  unproven email bindings: ${u.total} (${per}); ${u.demoted > 0 ? `${u.demoted} set back to observed` : "none changed"}`);
    if (u.demoted === 0 && !r.dryRun) lines.push("    to set them back to observed (a login with proof raises them again): slaude domain reconcile --demote-unproven-emails --apply");
  }
  if (r.linkTokensPurged > 0) lines.push(`  link tokens: ${r.linkTokensPurged} expired ledger row(s) ${r.dryRun ? "would be purged" : "purged"}`);
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
    if (totalCreated(r) === 0 && r.conflicts.length === 0) log("reconcile: nothing to do");
    else log(`reconcile done: ${totalCreated(r)} created, ${r.conflicts.length} conflict(s)\n${formatReconcileReport(r)}`);
    // Report only: demotion is an operator's explicit CLI run, never the boot hook's.
    if (r.unprovenEmails.total > 0) {
      log(`${r.unprovenEmails.total} verified email binding(s) have no proof of the address (before rc.19); nothing reads them for access yet. Report and fix: slaude domain reconcile --demote-unproven-emails --apply`);
    }
    return r;
  } catch (e) {
    console.error(`[domain] reconcile failed (boot continues): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
