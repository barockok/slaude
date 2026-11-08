/**
 * Owner guardrails across the gateway and its nodes (design section 2,
 * "Delivery to nodes" and "Version skew").
 *
 * The effective documents for a persona ride in the tenant runtime bundle the
 * node's soul resolver already reads, with the set's version as an explicit
 * input of the bundle's ETag, so any guardrail change busts node caches on its
 * own; publishConfigReload tells nodes to drop them at once.
 *
 * A node advertises the `guardrails/1` capability twice: on its registry
 * heartbeat (the dispatcher routes an agent with enforced rules only to nodes
 * that have it) and on every bundle fetch (the gateway refuses the bundle of
 * such an agent to a node that does not, audited guardrail.node.unsupported).
 * An older node can never run an agent's turns without its rules.
 */
import { env } from "../config/env";
import { currentGuardrails } from "./snapshot";
import { docsForAgent, hasEnforcedRules, resolveDocs, sessionGuardrails, type GuardrailDoc, type SessionGuardrails } from "./resolve";

export { CAPABILITIES_HEADER, GUARDRAILS_CAPABILITY, hasCapability } from "./capability";

/** The bundle field. Absent: the gateway has no guardrails (or predates them). */
export interface BundleGuardrails {
  version: number;
  /** The persona has enforced rules (a node without the capability is refused). */
  enforced: boolean;
  /** The always-loaded prose cap of the gateway's deployment. */
  proseMax: number;
  docs: GuardrailDoc[];
}

/** The bundle's guardrails for one persona, from the verified snapshot (throws when unavailable). */
export async function bundleGuardrailsFor(tenant: string, persona: string): Promise<BundleGuardrails | null> {
  const snap = await currentGuardrails(tenant, { persona });
  if (snap.version === 0) return null;
  return {
    version: snap.version,
    enforced: hasEnforcedRules(snap.resolved, persona),
    proseMax: env.guardrailProseMax(),
    docs: docsForAgent(snap.resolved, persona),
  };
}

/** A node's session guardrails from its bundle (none when the bundle has none). */
export function bundleSessionGuardrails(b: BundleGuardrails | null | undefined, persona: string, channel: string | null): SessionGuardrails | null {
  if (!b) return null;
  return sessionGuardrails(resolveDocs(b.docs), persona, channel, { version: b.version, proseMax: b.proseMax });
}

/** Whether the persona has enforced rules now (the dispatcher's check). Throws when unavailable. */
export async function personaNeedsGuardrails(tenant: string, persona: string): Promise<boolean> {
  const snap = await currentGuardrails(tenant, { persona });
  return hasEnforcedRules(snap.resolved, persona);
}
