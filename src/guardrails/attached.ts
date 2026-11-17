/**
 * The guardrails an agent.yaml attaches to its agent (`guardrails:` slugs),
 * applied at read time on the gateway and in mono. The attachment widens which
 * agents a guardrail covers; it never touches the guardrail's signed text, its
 * rules or its enabled state, so verification and integrity are unchanged.
 */
import { getPersonaRegistry, managedPersonaDefinition, type PersonaRegistry } from "../persona/registry";
import { withAgentAttachments, type ResolvedGuardrail } from "./resolve";

/** Guardrail slug -> the agents whose agent.yaml attaches it. */
export function attachmentsOf(r: PersonaRegistry = getPersonaRegistry()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (agent: string, slugs: readonly string[] | undefined) => {
    for (const slug of slugs ?? []) out.set(slug, [...(out.get(slug) ?? []), agent]);
  };
  add("default", managedPersonaDefinition(undefined, r)?.guardrails);
  for (const p of r.list()) add(p.name, p.definition?.guardrails);
  return out;
}

/** The snapshot's guardrails with every agent.yaml attachment in force. */
export function attachedResolved(resolved: readonly ResolvedGuardrail[], r: PersonaRegistry = getPersonaRegistry()): ResolvedGuardrail[] {
  return withAgentAttachments(resolved, attachmentsOf(r));
}
