import { agentSourceId } from "../knowledge/scope";

export type RemapResult =
  | { ok: true; target: string }
  | { ok: false; code: "kb_out_of_scope" | "no_mapping" | "forbidden_target"; source: string };

export interface RemapOptions {
  /** The persona's own agent slice (agentSourceForPersona of its Slack user id). */
  agentSource: string;
  map?: Record<string, string>;
}

/** The slice the gateway itself reads for this identity (never a hand-built `agent-<id>`). */
export function agentSourceForPersona(agentId: string): string {
  return agentSourceId(agentId);
}

export const isAgentLike = (s: string): boolean => s === "agent" || s.startsWith("agent-");
const isUser = (s: string): boolean => /^user-[a-z0-9]+$/.test(s);
const isKb = (s: string): boolean => s.startsWith("kb-");

/** A target a `map` entry may point at: the persona's slice, a user slice, shared, public. */
function allowedTarget(t: string, agentSource: string): boolean {
  return t === agentSource || t === "shared" || t === "public" || isUser(t);
}

export function validateMap(map: Record<string, string>, agentSource: string): string | null {
  for (const [from, to] of Object.entries(map)) {
    if (!allowedTarget(to, agentSource)) return `map target '${to}' (from '${from}') is not the persona's agent slice, a user slice, shared or public`;
  }
  return null;
}

export function remapSource(source: string, o: RemapOptions): RemapResult {
  // kb-* is refused before the map is consulted: a map cannot opt a kb source in.
  if (isKb(source)) return { ok: false, code: "kb_out_of_scope", source };
  // Own-property only: a source named "constructor" must not read the prototype chain.
  if (o.map && Object.hasOwn(o.map, source)) {
    const mapped = o.map[source]!;
    return allowedTarget(mapped, o.agentSource)
      ? { ok: true, target: mapped }
      : { ok: false, code: "forbidden_target", source };
  }
  if (isAgentLike(source)) return { ok: true, target: o.agentSource };
  if (source === "shared" || source === "public" || isUser(source)) return { ok: true, target: source };
  return { ok: false, code: "no_mapping", source };
}
