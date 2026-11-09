/** The node capability that says a node applies owner guardrails (src/guardrails/node.ts). */
export const GUARDRAILS_CAPABILITY = "guardrails/1";
/** The node capability that says a node applies an agent.yaml's skill list and attached guardrails. */
export const AGENT_DEFINITION_CAPABILITY = "agent-definition/1";
/** The request header a node lists its capabilities in. */
export const CAPABILITIES_HEADER = "x-slaude-capabilities";

/** Whether a capability list (comma separated) holds `cap`. */
export function hasCapability(header: string | null | undefined, cap = GUARDRAILS_CAPABILITY): boolean {
  return !!header && header.split(",").map((s) => s.trim()).includes(cap);
}

/** Whether a node must understand this agent's definition. Every agent.yaml
 *  persona needs it: an older node would ignore a skill list or attached
 *  guardrails, and leave the compiled global mandate out of the prompt. */
export function definitionNeedsNode(d: { skills?: string[]; guardrails?: string[] } | null | undefined): boolean {
  return !!d;
}
