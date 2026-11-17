/**
 * Person slices (slice F): which `user-` memory slices one person may READ, from
 * the Slack ids that person has proven. Computed at read time from the acting
 * user's current bindings, so unlink, undo and merge change access by moving
 * bindings, with no stored table to keep in step. Writes never come through
 * here: they stay on the writer's own slice.
 *
 * The rules (docs/plans/2026-11-15-domain-memory-credentials-slice-f.md):
 *  - P: the union is built only when the ACTING binding is `verified`, and it
 *    adds only slices of OTHER Slack bindings of the same user that are
 *    themselves `verified`. An observed or declared binding, on either side,
 *    contributes and receives nothing.
 *  - P2: both the acting binding and each added one need a row in `slack_identities`
 *    (the authoritative link) for an account of the same user, so a missed unlink
 *    projection cannot keep a union alive. The ADDED binding must also be older than
 *    SLAUDE_PERSON_SLICES_HOLD_HOURS (default 24, by its own `verified_at`): the
 *    mitigation for a mistaken link.
 *  - Q: a name is dropped when a binding of a DIFFERENT live user (any state,
 *    any workspace) produces the same slice name.
 *  - R: only `user-<alnum>` names. The result is validated against the verified
 *    bindings before it is returned; no `agent`, `shared`, `public`, `kb-` or
 *    `profile-` name can come out of this path.
 *  - T: any error, the 250 ms bound or a tombstone read failure returns the
 *    legacy own slice and counts a failure; never a wider set.
 *  Operator tombstones (`slice_tombstones`) drop one name, or all with `*`.
 *
 * Never resolved for a /1on1 lock owner's id (Rule S): callers pass the speaker
 * or the job token's `runAs` person only. This module touches the database, so
 * only gateway code may import it (a guard test keeps nodes away).
 */
import * as Domain from "../db/domain";
import { env } from "../config/env";
import { tombstonesFor } from "../db/slice-tombstones";
import { db } from "../db/schema";
import { m } from "../metrics";
import { actingUser } from "../refs/actor";
import { userSourceId, type PersonSlices } from "./scope";

export type { PersonSlices };

export type PersonStatus = "ok" | "no_user" | "error";

export interface PersonSlicesResult {
  slices: PersonSlices;
  status: PersonStatus;
  ms: number;
  /** Settles when the underlying queries have finished, even after the bound cut the wait (so an in-flight cap can track real load). */
  done?: Promise<void>;
}

/** The resolver's bound (Rule T). */
export const RESOLVER_TIMEOUT_MS = 250;

const PERSON_NAME = /^user-[a-z0-9]+$/;

/** Own slice only, no database: what rc.21 reads. */
export function legacyPersonSlices(slackUserId: string): PersonSlices {
  const own = userSourceId(slackUserId);
  return { own, reads: [own], via: "legacy", dropped: { conflict: 0, tombstoned: 0 } };
}

class ResolverTimeout extends Error {
  constructor() {
    super("person slice resolver timed out");
    this.name = "ResolverTimeout";
  }
}

/**
 * Rule P2: the authoritative link table. The (team, Slack id) pairs linked, in `slack_identities`,
 * to an account whose user (oidc binding) is `userId`. A verified binding the projection failed
 * to remove after an unlink has no row here, so a missed `projectUnlink` cannot keep a union alive.
 */
async function linkedPairs(userId: string): Promise<Set<string>> {
  const rows = await db.query<{ team: string; value: string }>(
    `SELECT s.team_id AS team, s.slack_user_id AS value
     FROM slack_identities s
     JOIN accounts a ON a.id = s.account_id
     JOIN bindings o ON o.service = 'oidc' AND o.kind = 'subject' AND o.workspace = a.issuer AND o.value = a.subject
     WHERE o.user_id = ?`,
    [userId],
  );
  return new Set(rows.map((r) => `${r.team}\u0000${r.value}`));
}

async function resolve(teamId: string, slackUserId: string): Promise<{ slices: PersonSlices; status: PersonStatus }> {
  const legacy = legacyPersonSlices(slackUserId);
  const actor = await actingUser(teamId, slackUserId, { fresh: true });
  if (!actor) return { slices: legacy, status: "no_user" };
  // Rule P, reader side: an observed or declared acting binding reads its own slice only.
  if (!actor.verified) return { slices: legacy, status: "ok" };

  const bindings = await Domain.bindingsOf(actor.userId, { service: "slack", kind: "user", states: ["verified"] });
  const others = bindings.filter((b) => b.id !== actor.slackBinding.id);
  if (others.length === 0) return { slices: legacy, status: "ok" };

  // Rule P2, both sides: the acting binding and each added one must hold a link to an account of this user.
  const links = await linkedPairs(actor.userId);
  const key = (team: string, value: string) => `${team}\u0000${value}`;
  const acting = await Domain.findBinding({ service: "slack", kind: "user", workspace: teamId, value: slackUserId });
  if (!acting || !links.has(key(acting.workspace, acting.value))) return { slices: legacy, status: "ok" };

  // The hold on the ADDED binding, read from the binding row itself.
  const holdMs = env.slices.holdHours() * 3_600_000;
  const now = Date.now();
  let held = 0;
  const produced = new Map<string, string>(); // slice name -> a slack value that produces it
  const verifiedNames = new Set<string>();
  for (const b of others) {
    if (!links.has(key(b.workspace, b.value))) continue;
    const name = userSourceId(b.value);
    if (name === legacy.own || !PERSON_NAME.test(name)) continue;
    verifiedNames.add(name);
    if (holdMs > 0 && (b.verified_at === null || now - Number(b.verified_at) < holdMs)) {
      held++;
      continue;
    }
    if (!produced.has(name)) produced.set(name, b.value);
  }
  const dropped: PersonSlices["dropped"] = { conflict: 0, tombstoned: 0, ...(held > 0 ? { held } : {}) };
  if (produced.size === 0) return { slices: { ...legacy, dropped }, status: "ok" };

  // Rule Q: names a different live user's binding (any state, any workspace) also produces. Compared
  // on the normalised slice name; the lookup uses exact stored values (Slack ids are stored as given,
  // upper-case) so it can use the index prefix instead of scanning with LOWER().
  const variants = [...new Set([...produced.values()].flatMap((v) => [v, v.toUpperCase(), v.toLowerCase()]))];
  const claimed = await db.query<{ value: string }>(
    `SELECT DISTINCT value FROM bindings WHERE service = 'slack' AND kind = 'user' AND value IN (${variants.map(() => "?").join(", ")}) AND user_id <> ?`,
    [...variants, actor.userId],
  );
  const claimedNames = new Set(claimed.map((r) => userSourceId(r.value)));
  for (const name of [...produced.keys()]) {
    if (claimedNames.has(name)) {
      produced.delete(name);
      dropped.conflict++;
    }
  }

  // Operator tombstones: the user's own rows and the source-level rows.
  const t = await tombstonesFor(actor.userId);
  if (t.all) {
    dropped.tombstoned = produced.size;
    produced.clear();
  } else {
    for (const name of [...produced.keys()]) {
      if (t.names.has(name)) {
        produced.delete(name);
        dropped.tombstoned++;
      }
    }
  }

  // Rule R, validated on the way out: every added name is a person name produced by a verified, linked binding of this user.
  const added = [...produced.keys()].filter((n) => PERSON_NAME.test(n) && verifiedNames.has(n) && n !== legacy.own).sort();
  if (added.length === 0) return { slices: { ...legacy, dropped }, status: "ok" };
  return { slices: { own: legacy.own, reads: [legacy.own, ...added], via: "union", dropped }, status: "ok" };
}

/**
 * The resolver with its status and timing, for the shadow seam. Never throws: a
 * failure or the bound gives the legacy own slice with `status: "error"` and
 * counts `slaude_person_slices_failures_total`.
 */
export async function personSlicesDetailed(teamId: string | null | undefined, slackUserId: string, opts: { timeoutMs?: number } = {}): Promise<PersonSlicesResult> {
  const t0 = performance.now();
  const legacy = legacyPersonSlices(slackUserId);
  const finish = (slices: PersonSlices, status: PersonStatus): PersonSlicesResult => {
    const ms = performance.now() - t0;
    try {
      m.personSlicesMs.observe(ms);
      if (status === "error") m.personSlicesFailuresTotal.inc();
    } catch {
      /* counting must never fail a read */
    }
    return { slices, status, ms };
  };
  if (!teamId || !slackUserId) return finish(legacy, "no_user");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: Promise<void> = Promise.resolve();
  const fin = (slices: PersonSlices, status: PersonStatus): PersonSlicesResult => ({ ...finish(slices, status), done });
  try {
    const bound = opts.timeoutMs ?? RESOLVER_TIMEOUT_MS;
    const work = resolve(teamId, slackUserId);
    done = work.then(
      () => {},
      () => {},
    );
    const r = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ResolverTimeout()), bound);
      }),
    ]);
    return fin(r.slices, r.status);
  } catch {
    return fin(legacy, "error");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The slices one acting Slack id may read: fresh, bounded, never throws. */
export async function personSlices(teamId: string | null | undefined, slackUserId: string): Promise<PersonSlices> {
  return (await personSlicesDetailed(teamId, slackUserId)).slices;
}
