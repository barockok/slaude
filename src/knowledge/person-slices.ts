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

async function resolve(teamId: string, slackUserId: string): Promise<{ slices: PersonSlices; status: PersonStatus }> {
  const legacy = legacyPersonSlices(slackUserId);
  const actor = await actingUser(teamId, slackUserId, { fresh: true });
  if (!actor) return { slices: legacy, status: "no_user" };
  // Rule P, reader side: an observed or declared acting binding reads its own slice only.
  if (!actor.verified) return { slices: legacy, status: "ok" };

  const bindings = await Domain.bindingsOf(actor.userId, { service: "slack", kind: "user", states: ["verified"] });
  const produced = new Map<string, string>(); // slice name -> a slack value that produces it
  for (const b of bindings) {
    if (b.id === actor.slackBinding.id) continue;
    const name = userSourceId(b.value);
    if (name === legacy.own || !PERSON_NAME.test(name)) continue;
    if (!produced.has(name)) produced.set(name, b.value);
  }
  if (produced.size === 0) return { slices: legacy, status: "ok" };

  // Rule Q: names a different live user's binding (any state, any workspace) also produces.
  let conflict = 0;
  const values = [...new Set([...produced.values()].map((v) => v.toLowerCase()))];
  const claimed = await db.query<{ value: string }>(
    `SELECT DISTINCT value FROM bindings WHERE service = 'slack' AND LOWER(value) IN (${values.map(() => "?").join(", ")}) AND user_id <> ?`,
    [...values, actor.userId],
  );
  const claimedNames = new Set(claimed.map((r) => userSourceId(r.value)));
  for (const name of [...produced.keys()]) {
    if (claimedNames.has(name)) {
      produced.delete(name);
      conflict++;
    }
  }

  // Operator tombstones.
  let tombstoned = 0;
  const t = await tombstonesFor(actor.userId);
  if (t.all) {
    tombstoned = produced.size;
    produced.clear();
  } else {
    for (const name of [...produced.keys()]) {
      if (t.names.has(name)) {
        produced.delete(name);
        tombstoned++;
      }
    }
  }

  // Rule R, validated on the way out: every added name is a person name produced by a verified binding of this user.
  const verifiedNames = new Set(bindings.map((b) => userSourceId(b.value)));
  const added = [...produced.keys()].filter((n) => PERSON_NAME.test(n) && verifiedNames.has(n) && n !== legacy.own).sort();
  const dropped = { conflict, tombstoned };
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
  try {
    const bound = opts.timeoutMs ?? RESOLVER_TIMEOUT_MS;
    const r = await Promise.race([
      resolve(teamId, slackUserId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ResolverTimeout()), bound);
      }),
    ]);
    return finish(r.slices, r.status);
  } catch {
    return finish(legacy, "error");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The slices one acting Slack id may read: fresh, bounded, never throws. */
export async function personSlices(teamId: string | null | undefined, slackUserId: string): Promise<PersonSlices> {
  return (await personSlicesDetailed(teamId, slackUserId)).slices;
}
