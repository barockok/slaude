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
