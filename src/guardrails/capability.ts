/** The node capability that says a node applies owner guardrails (src/guardrails/node.ts). */
export const GUARDRAILS_CAPABILITY = "guardrails/1";
/** The request header a node lists its capabilities in. */
export const CAPABILITIES_HEADER = "x-slaude-capabilities";

/** Whether a capability list (comma separated) holds `cap`. */
export function hasCapability(header: string | null | undefined, cap = GUARDRAILS_CAPABILITY): boolean {
  return !!header && header.split(",").map((s) => s.trim()).includes(cap);
}
