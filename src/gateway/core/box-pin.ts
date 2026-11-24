/**
 * Which box a session runs in, decided by the gateway at dispatch (box spec,
 * "Refresh semantics", "Pin").
 *
 * With SLAUDE_BOX off this answers null for every session and reads nothing.
 * With it on, a persona that names a box (or the deployment default) has each
 * of its sessions pinned to the box's current digest at the session's first
 * dispatch, by compare-and-set from null. A session never moves on its own: a
 * later box version changes new sessions only. The policy is not pinned: a
 * pinned session runs under the box's current policy.
 *
 * Every failure here throws. The caller refuses the turn; a boxed persona's
 * turn is never dispatched unboxed because its box could not be read.
 */
import { emitAudit } from "../../audit/emit";
import { unboxableProviderForms } from "../../box/provider-forms";
import type { BoxTier } from "../../box/policy";
import { env } from "../../config/env";
import { pinSessionBox, sessionBox } from "../../db/boxes";
import { getPersonaRegistry, managedPersonaDefinition } from "../../persona/registry";
import { currentBox, pinnedBox, type BoxVersion } from "./box-registry";

export interface SessionBoxPin {
  name: string;
  /** `sha256:<digest>`: the image this session runs, for as long as it is not refreshed. */
  digest: string;
  /** The weakest tier the box's current policy accepts. */
  tier: BoxTier;
}

/** The box named for a persona could not be resolved; the turn is refused. */
export class BoxUnavailableError extends Error {}

export interface BoxPinDeps {
  enabled: () => boolean;
  /** The box a persona runs in by name, or null when it names none. */
  boxNameFor: (persona: string) => string | null;
  /** The provider credential forms the persona declares that a box cannot serve. */
  unboxableForms: (persona: string) => string[];
  current: (tenant: string, name: string) => Promise<BoxVersion | null>;
  pinned: (tenant: string, name: string, digest: string) => Promise<BoxVersion | null>;
  read: (sessionId: string) => Promise<{ name: string; digest: string } | null>;
  pin: (sessionId: string, box: { name: string; digest: string }) => Promise<{ name: string; digest: string; pinned: boolean } | null>;
  audit: typeof emitAudit;
}

const registryKey = (persona: string) => (persona === "default" ? undefined : persona);

export const defaultBoxPinDeps: BoxPinDeps = {
  enabled: () => env.box.enabled(),
  boxNameFor: (persona) => managedPersonaDefinition(registryKey(persona))?.box ?? env.box.defaultBox(),
  unboxableForms: (persona) => {
    const r = getPersonaRegistry();
    const p = persona === "default" ? r.defaultPersona?.() : r.lookupByName(persona);
    return unboxableProviderForms((p as { provider?: Record<string, unknown> | null } | null | undefined)?.provider ?? null);
  },
  current: (tenant, name) => currentBox(tenant, name),
  pinned: (tenant, name, digest) => pinnedBox(tenant, name, digest),
  read: (sessionId) => sessionBox(sessionId),
  pin: (sessionId, box) => pinSessionBox(sessionId, box),
  audit: emitAudit,
};

const warnedUnboxable = new Set<string>();

/**
 * The session's box, pinning it on the first call. Null: the session is not
 * boxed. Throws BoxUnavailableError (or the registry's BoxIntegrityError) when
 * a box is named and cannot be served.
 */
export async function sessionBoxPin(
  ctx: { tenant: string; persona: string; sessionId: string },
  deps: BoxPinDeps = defaultBoxPinDeps,
): Promise<SessionBoxPin | null> {
  if (!deps.enabled()) return null;
  const name = deps.boxNameFor(ctx.persona);
  if (!name) return null;
  // No secret enters a box. A persona whose credential form the provider
  // proxy cannot serve is not boxable: it runs unboxed (the sync warned), and
  // the token is never put into a box to make it work.
  const bad = deps.unboxableForms(ctx.persona);
  if (bad.length) {
    if (!warnedUnboxable.has(ctx.persona)) {
      warnedUnboxable.add(ctx.persona);
      console.warn(`[box] persona=${ctx.persona} names box '${name}' but uses a provider credential form a box cannot serve (${bad.join(", ")}); it runs unboxed`);
    }
    return null;
  }
  const existing = await deps.read(ctx.sessionId);
  if (existing) {
    const at = await deps.pinned(ctx.tenant, existing.name, existing.digest);
    if (!at) throw new BoxUnavailableError(`session is pinned to box '${existing.name}' at a digest the gateway no longer has`);
    return { name: existing.name, digest: existing.digest, tier: at.policy.tier };
  }
  const cur = await deps.current(ctx.tenant, name);
  if (!cur) throw new BoxUnavailableError(`persona names box '${name}', which is not defined`);
  const pin = await deps.pin(ctx.sessionId, { name, digest: cur.digest });
  if (!pin) throw new BoxUnavailableError("the session row could not be pinned to its box");
  if (pin.pinned) {
    deps.audit({
      tenantId: ctx.tenant,
      persona: ctx.persona,
      actorKind: "system",
      actorId: "dispatch",
      action: "box.pinned",
      targetKind: "session",
      targetId: ctx.sessionId,
      sessionId: ctx.sessionId,
      summary: `session pinned to box ${name} version ${cur.version}`,
      details: { box: name, version: cur.version, digest: cur.digest },
    });
    return { name, digest: cur.digest, tier: cur.policy.tier };
  }
  // Another dispatch pinned first: its digest is the session's.
  const at = await deps.pinned(ctx.tenant, pin.name, pin.digest);
  if (!at) throw new BoxUnavailableError(`session is pinned to box '${pin.name}' at a digest the gateway no longer has`);
  return { name: pin.name, digest: pin.digest, tier: at.policy.tier };
}

/** TEST SEAM: forget which personas were warned about. */
export function __resetBoxPinForTests(): void {
  warnedUnboxable.clear();
}
