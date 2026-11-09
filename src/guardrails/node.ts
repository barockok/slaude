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
import { docsForAgent, hasEnforcedRules, resolveDocs, sessionGuardrails, withAgentAttachments, type GuardrailDoc, type SessionGuardrails } from "./resolve";
import { attachedResolved, attachmentsOf } from "./attached";

export { AGENT_DEFINITION_CAPABILITY, CAPABILITIES_HEADER, definitionNeedsNode, GUARDRAILS_CAPABILITY, hasCapability } from "./capability";

/** The bundle field. Absent: the gateway has no guardrails (or predates them). */
export interface BundleGuardrails {
  version: number;
  /** The persona has enforced rules (a node without the capability is refused). */
  enforced: boolean;
  /** The always-loaded prose cap of the gateway's deployment. */
  proseMax: number;
  docs: GuardrailDoc[];
  /** Guardrails the persona's agent.yaml attaches (the text is in `docs`).
   *  Absent when it attaches none, so other bundles and their ETags are unchanged. */
  attached?: string[];
}

/** The bundle's guardrails for one persona, from the verified snapshot (throws when unavailable). */
export async function bundleGuardrailsFor(tenant: string, persona: string): Promise<BundleGuardrails | null> {
  const snap = await currentGuardrails(tenant, { persona });
  if (snap.version === 0) return null;
  const resolved = attachedResolved(snap.resolved);
  const attached = [...attachmentsOf()].filter(([, agents]) => agents.includes(persona)).map(([slug]) => slug);
  return {
    version: snap.version,
    enforced: hasEnforcedRules(resolved, persona),
    proseMax: env.guardrailProseMax(),
    docs: docsForAgent(resolved, persona),
    ...(attached.length ? { attached } : {}),
  };
}

/** A node's session guardrails from its bundle (none when the bundle has none). */
export function bundleSessionGuardrails(b: BundleGuardrails | null | undefined, persona: string, channel: string | null): SessionGuardrails | null {
  if (!b) return null;
  const resolved = withAgentAttachments(resolveDocs(b.docs), new Map((b.attached ?? []).map((slug) => [slug, [persona]])));
  return sessionGuardrails(resolved, persona, channel, { version: b.version, proseMax: b.proseMax });
}

/** Whether the persona has enforced rules now (the dispatcher's check). Throws when unavailable. */
export async function personaNeedsGuardrails(tenant: string, persona: string): Promise<boolean> {
  const snap = await currentGuardrails(tenant, { persona });
  return hasEnforcedRules(attachedResolved(snap.resolved), persona);
}
