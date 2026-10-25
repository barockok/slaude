import { agentSourceId, isProfileSourceId } from "../knowledge/scope";

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
/** A person's own source: their `user-` slice or their `profile-` source.
 *  Either passes through unchanged (it belongs to the person, not the persona). */
export const isPersonSource = (s: string): boolean => /^user-[a-z0-9]+$/.test(s) || isProfileSourceId(s);
const isKb = (s: string): boolean => s.startsWith("kb-");

/** A target a source may land in: the persona's slice, a person's source (user or profile), shared, public.
 *  With `from` (a `map` entry's source), a profile is a target only for itself: a profile holds the
 *  person's own words, so no other source (another slice, another person's profile) is poured into it. */
export function allowedTarget(t: string, agentSource: string, from?: string): boolean {
  if (from !== undefined && isProfileSourceId(t) && from !== t) return false;
  return t === agentSource || t === "shared" || t === "public" || isPersonSource(t);
}

export function validateMap(map: Record<string, string>, agentSource: string): string | null {
  for (const [from, to] of Object.entries(map)) {
    if (!allowedTarget(to, agentSource, from)) return `map target '${to}' (from '${from}') is not the persona's agent slice, a user source, the same profile source, shared or public`;
  }
  return null;
}

export function remapSource(source: string, o: RemapOptions): RemapResult {
  // kb-* is refused before the map is consulted: a map cannot opt a kb source in.
  if (isKb(source)) return { ok: false, code: "kb_out_of_scope", source };
  // Own-property only: a source named "constructor" must not read the prototype chain.
  if (o.map && Object.hasOwn(o.map, source)) {
    const mapped = o.map[source]!;
    return allowedTarget(mapped, o.agentSource, source)
      ? { ok: true, target: mapped }
      : { ok: false, code: "forbidden_target", source };
  }
  if (isAgentLike(source)) return { ok: true, target: o.agentSource };
  if (source === "shared" || source === "public" || isPersonSource(source)) return { ok: true, target: source };
  return { ok: false, code: "no_mapping", source };
}
