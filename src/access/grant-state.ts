/**
 * What a grant that names a person by `email:` or `user:` does right now (slice C
 * task 22), for the console. Read only; the access decision itself is the
 * engine's (`authority.ts`), this only explains why a grant is not (yet) in effect.
 *
 *  - `active`: the person is known and the grant reaches them. A deny is active
 *    as soon as the email is held by anyone (a deny applies from observed
 *    bindings, Rule C).
 *  - `pending: no verified email binding`: nobody holds that email as a verified
 *    binding (the person has not logged in with a proven email, or the address is
 *    only declared or observed). An `email:` member grant does nothing yet.
 *  - `pending: Slack binding not verified`: a manager or approver grant whose
 *    person has no verified Slack binding (they have not used the portal link),
 *    so the privileged part does not apply (Rule D).
 *  - `inactive: access source is not internal`: the grant is stored, but the
 *    gateway is not running the internal path, so nothing reads it.
 *
 * Slack subjects have no state (they are in effect as they always were).
 */
import * as Domain from "../db/domain";
import { db } from "../db/schema";
import { getPersonaRegistry } from "../persona/registry";
import { soulDataFor } from "../soul/per-persona";
import { env } from "../config/env";
import type { Grant } from "./grants";
import { grantSubject } from "./authority";
import type { GrantState } from "../gateway/panel/api-types";

export type { GrantState };

export const GRANT_STATES: readonly GrantState[] = [
  "active",
  "pending: no verified email binding",
  "pending: Slack binding not verified",
  "inactive: access source is not internal",
];

/** The state of a grant that names a person by email or user reference; null for any other subject. */
export async function grantState(g: Grant): Promise<GrantState | null> {
  if (g.subjectKind !== "user") return null;
  const s = grantSubject(g);
  if (!s || s.service === "slack") return null;
  if (env.access.source() !== "internal") return "inactive: access source is not internal";
  try {
    let userId: string | null = null;
    if (s.service === "email") {
      const b = await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: s.address });
      if (!b) return "pending: no verified email binding";
      // A deny applies from an observed email too; anything else needs the proof.
      if (b.state === "declared" || (b.state === "observed" && !g.deny)) return "pending: no verified email binding";
      userId = (await Domain.resolveUserId(b.user_id)) ?? b.user_id;
    } else {
      userId = await Domain.resolveUserId(s.userId);
      if (!userId) return "pending: Slack binding not verified";
    }
    const privileged = !g.deny && (g.role === "manager" || g.role === "approver");
    if (!privileged) return "active";
    const verified = await Domain.bindingsOf(userId, { service: "slack", kind: "user", states: ["verified"] });
    return verified.length ? "active" : "pending: Slack binding not verified";
  } catch {
    return null;
  }
}

export interface InactiveRefs {
  /** Stored grants naming a person by email or user reference. */
  stored: number;
  /** Of those, denies. */
  storedDeny: number;
  /** `email:` and `user:` entries in compiled agent.yaml access (accessRefs). */
  soulRefs: number;
  /** Of those, denies (`access.blocked`). */
  soulDeny: number;
}

/** What exists that only the internal source reads. Read only. */
export async function inactiveRefs(): Promise<InactiveRefs> {
  const out: InactiveRefs = { stored: 0, storedDeny: 0, soulRefs: 0, soulDeny: 0 };
  const rows = await db.query<{ deny: boolean | number }>("SELECT deny FROM agent_grants WHERE subject_kind = 'user' AND (subject_id LIKE 'email:%' OR subject_id LIKE 'user:%')");
  out.stored = rows.length;
  out.storedDeny = rows.filter((r) => Boolean(r.deny)).length;
  const reg = getPersonaRegistry();
  for (const name of ["default", ...reg.list().map((p) => p.name).filter((n) => n !== "default")]) {
    for (const r of soulDataFor(name).accessRefs ?? []) {
      out.soulRefs++;
      if (r.deny) out.soulDeny++;
    }
  }
  return out;
}

/**
 * One boot line when email or user references exist but the access source is
 * not internal: they are inactive then, and a deny by email is NOT enforced.
 * Never throws.
 */
export async function warnInactiveRefs(log: (m: string) => void = (m) => console.warn(`[access] ${m}`)): Promise<void> {
  try {
    if (env.access.source() === "internal") return;
    const r = await inactiveRefs();
    if (r.stored + r.soulRefs === 0) return;
    log(
      `${r.stored} stored grant(s) and ${r.soulRefs} agent.yaml access reference(s) name a person by email or user and are inactive: SLAUDE_ACCESS_SOURCE is not internal. ` +
        `Denies by email are NOT enforced (${r.storedDeny + r.soulDeny}); a person they block is admitted again. Set SLAUDE_ACCESS_SOURCE=internal, or delete them.`,
    );
  } catch {
    /* a boot line must never fail boot */
  }
}
