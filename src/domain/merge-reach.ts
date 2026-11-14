/**
 * Which grants reach a user, and which of those take effect (slice C, task 25).
 * Read only. The merge engine runs it for the survivor before and after a move
 * and diffs the two: what became effective is `activated`, what reaches the
 * person but waits for a verified Slack binding is `inactive_privileged`.
 *
 * Reach follows Rule B (the authority engine has the full statement):
 *  - `slack:` entry: the user holds an observed or verified Slack binding with
 *    that id (and the written workspace, when there is one);
 *  - `email:` entry: the user holds a VERIFIED email binding for the address;
 *  - `user:` entry: the id resolves, through aliases, to this user.
 * A declared binding never reaches anyone. Denies are not counted (a merge
 * never needs to announce a block). Effect follows Rule D: a manager or
 * approver grant takes effect when the user has a verified Slack binding (a
 * direct `slack:` entry keeps today's behaviour unless
 * SLAUDE_PRIVILEGED_NEEDS_VERIFIED is on). The ledger keeps `grant:<id>` or
 * `soul:<service>` as the entry, never an address or a Slack id.
 */
import * as Domain from "../db/domain";
import type { DbClient } from "../db/schema";
import { env } from "../config/env";
import { parseRef } from "../refs/parse";
import { deriveSoulGrants, type Grant } from "../access/grants";
import { grantSubject } from "../access/authority";
import { channelApproversOf, soulDataFor } from "../soul/per-persona";
import { getPersonaRegistry } from "../persona/registry";

export interface ReachedGrant {
  /** Stable identity of the grant for a before/after diff. */
  key: string;
  persona: string;
  role: "manager" | "approver" | "member";
  source: "soul" | "console";
  /** `grant:<id>` or `soul:<service>`: never a binding value. */
  entry: string;
  privileged: boolean;
  /** Takes effect now (a privileged grant needs the verified Slack binding). */
  effective: boolean;
}

interface Held {
  slack: { team: string; id: string }[];
  verifiedEmails: Set<string>;
  hasVerifiedSlack: boolean;
}

async function held(userId: string, c: DbClient): Promise<Held> {
  const bs = await c.query<Domain.BindingRow>("SELECT * FROM bindings WHERE user_id = ? ORDER BY created_at, id", [userId]);
  return {
    slack: bs.filter((b) => b.service === "slack" && b.kind === "user" && b.state !== "declared").map((b) => ({ team: b.workspace, id: b.value })),
    verifiedEmails: new Set(bs.filter((b) => b.service === "email" && b.state === "verified").map((b) => b.value)),
    hasVerifiedSlack: bs.some((b) => b.service === "slack" && b.kind === "user" && b.state === "verified"),
  };
}

type Subject = { service: "slack"; workspace?: string; id: string } | { service: "email"; address: string } | { service: "user"; userId: string };

async function reaches(s: Subject, userId: string, h: Held, c: DbClient): Promise<boolean> {
  switch (s.service) {
    case "slack":
      return h.slack.some((b) => b.id === s.id && (!s.workspace || s.workspace === b.team));
    case "email":
      return h.verifiedEmails.has(s.address);
    case "user":
      return (await Domain.resolveUserId(s.userId, c)) === userId;
  }
}

function privilegedEffective(s: Subject, h: Held): boolean {
  if (s.service === "slack") return !env.access.privilegedNeedsVerified() || h.hasVerifiedSlack;
  if (s.service === "email") return h.verifiedEmails.has(s.address) && h.hasVerifiedSlack;
  return h.hasVerifiedSlack;
}

function storedSubject(r: { subject_id: string; subject_ref: string | null }): Subject | null {
  if (r.subject_id.startsWith("email:")) return { service: "email", address: r.subject_id.slice("email:".length) };
  if (r.subject_id.startsWith("user:")) return { service: "user", userId: r.subject_id.slice("user:".length) };
  const parsed = r.subject_ref ? parseRef(r.subject_ref) : null;
  const workspace = parsed?.ok && parsed.ref.kind === "external" ? parsed.ref.workspace : undefined;
  return { service: "slack", id: r.subject_id, ...(workspace ? { workspace } : {}) };
}

function soulSubject(g: Grant): Subject | null {
  const s = grantSubject(g);
  if (!s) return null;
  if (s.service === "slack") return { service: "slack", id: g.subjectId, ...(s.workspace ? { workspace: s.workspace } : {}) };
  return s.service === "email" ? { service: "email", address: s.address } : { service: "user", userId: s.userId };
}

/** Soul-derived grants of every persona, by name. A soul that cannot be read contributes nothing. */
function soulGrantsByPersona(): Array<[string, Grant[]]> {
  const out: Array<[string, Grant[]]> = [];
  let names: string[] = ["default"];
  try {
    names = ["default", ...getPersonaRegistry().list().map((p) => p.name).filter((n) => n !== "default")];
  } catch {
    /* no registry: the default persona only */
  }
  for (const name of names) {
    try {
      const soul = soulDataFor(name);
      out.push([name, deriveSoulGrants(soul, channelApproversOf(soul))]);
    } catch {
      /* an unreadable soul reaches nobody */
    }
  }
  return out;
}

/** Every non-deny user grant that reaches `userId`, with whether it takes effect. */
export async function grantsReaching(userId: string, c: DbClient, now: number = Date.now()): Promise<ReachedGrant[]> {
  const h = await held(userId, c);
  const out: ReachedGrant[] = [];
  const push = (r: Omit<ReachedGrant, "privileged" | "effective" | "key">, s: Subject, key: string) => {
    const privileged = r.role === "manager" || r.role === "approver";
    out.push({ ...r, key, privileged, effective: !privileged || privilegedEffective(s, h) });
  };
  const rows = await c.query<{
    id: string; persona: string; subject_id: string; subject_ref: string | null; role: "manager" | "approver" | "member";
    deny: boolean | number; dm_only: boolean | number; expires_at: number | string | null;
  }>("SELECT id, persona, subject_id, subject_ref, role, deny, dm_only, expires_at FROM agent_grants WHERE subject_kind = 'user' ORDER BY created_at, id");
  for (const r of rows) {
    if (Boolean(r.deny)) continue;
    if (r.expires_at !== null && Number(r.expires_at) <= now) continue;
    const s = storedSubject(r);
    if (!s || !(await reaches(s, userId, h, c))) continue;
    push({ persona: r.persona, role: r.role, source: "console", entry: `grant:${r.id}` }, s, `console|${r.id}`);
  }
  for (const [persona, grants] of soulGrantsByPersona()) {
    for (const g of grants) {
      if (g.deny || g.subjectKind !== "user") continue;
      const s = soulSubject(g);
      if (!s || !(await reaches(s, userId, h, c))) continue;
      push(
        { persona, role: g.role, source: "soul", entry: `soul:${s.service}` },
        s,
        `soul|${persona}|${g.role}|${g.channelId ?? ""}|${g.dmOnly ? 1 : 0}|${g.subjectId}`,
      );
    }
  }
  return out;
}

export interface GrantDiff {
  activated: Array<{ persona: string; role: string; source: string; entry: string; privileged: boolean }>;
  inactivePrivileged: Array<{ persona: string; role: string; entry: string }>;
}

/** What became effective, and what reaches the person but waits for a verified Slack binding. */
export function diffReach(before: readonly ReachedGrant[], after: readonly ReachedGrant[]): GrantDiff {
  const eff = new Set(before.filter((g) => g.effective).map((g) => g.key));
  const reached = new Set(before.map((g) => g.key));
  return {
    activated: after
      .filter((g) => g.effective && !eff.has(g.key))
      .map((g) => ({ persona: g.persona, role: g.role, source: g.source, entry: g.entry, privileged: g.privileged })),
    inactivePrivileged: after
      .filter((g) => g.privileged && !g.effective && !reached.has(g.key))
      .map((g) => ({ persona: g.persona, role: g.role, entry: g.entry })),
  };
}
