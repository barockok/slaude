/**
 * Read models behind the console API (agent platform, console part): agents
 * with their mandates and grants. Built from the live persona registry, the
 * mandate read model and the grant store; nothing here writes.
 */
import * as AgentGrants from "../../db/agent-grants";
import { effectiveGrants } from "../../access/grants";
import { listMandates } from "../../mandate";
import { getPersonaRegistry, managedPersonaModel, runsOnFor, type PersonaRegistry } from "../../persona/registry";
import type { Registry } from "../../queue/registry";
import type { AgentSummary, ConsoleGrantView, GrantView, MandateView, SoulGrantView } from "./api-types";

/** Every live agent name: `default` first, then the registry's personas by name. */
export function agentNames(r: PersonaRegistry = getPersonaRegistry()): string[] {
  return ["default", ...r.list().map((p) => p.name).filter((n) => n !== "default").sort()];
}

/** Whether `name` is a live agent (the default persona always is). */
export function isAgent(name: string, r: PersonaRegistry = getPersonaRegistry()): boolean {
  return name === "default" || r.lookupByName(name) !== null;
}

export function consoleGrantView(g: AgentGrants.AgentGrantRow): ConsoleGrantView {
  return {
    source: "console",
    id: g.id,
    subjectKind: g.subjectKind,
    subjectId: g.subjectId,
    role: g.role,
    deny: g.deny,
    dmOnly: g.dmOnly,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    note: g.note,
  };
}

/** Effective grants: soul-derived, then the stored unexpired console grants. */
export async function grantViews(name: string, now: number = Date.now()): Promise<GrantView[]> {
  const soul: SoulGrantView[] = effectiveGrants(name, []).map((g) => ({
    source: "soul",
    subjectKind: g.subjectKind,
    subjectId: g.subjectId,
    role: g.role,
    deny: g.deny,
    dmOnly: g.dmOnly,
    channelId: g.channelId ?? null,
  }));
  const stored = (await AgentGrants.listForPersona(name, now)).map(consoleGrantView);
  return [...soul, ...stored];
}

export interface LivenessDeps {
  /** Where turns run: `mono` serves every agent in-process. */
  role: "gateway" | "mono";
  registry: Pick<Registry, "liveNodesPerLabel"> | null;
}

/** Label -> live node count, or null when unreadable (no registry, or a failed read). */
async function liveCounts(deps: LivenessDeps): Promise<Map<string, number> | null> {
  if (deps.role === "mono") return null;
  if (!deps.registry) return null;
  try {
    return await deps.registry.liveNodesPerLabel();
  } catch (e) {
    console.error(`[panel] node liveness read failed: ${e instanceof Error ? e.name : typeof e}`);
    return null;
  }
}

function summaryOf(
  name: string,
  r: PersonaRegistry,
  live: Map<string, number> | null,
  role: LivenessDeps["role"],
  mandateCount: number,
  grantCount: number,
): AgentSummary {
  const runsOn = runsOnFor(name, r);
  return {
    name,
    slackUserId: name === "default" ? null : (r.lookupByName(name)?.slackUserId ?? null),
    model: managedPersonaModel(name, r) ?? null,
    runsOn,
    live: role === "mono" ? true : live ? (live.get(runsOn) ?? 0) > 0 : null,
    mandateCount,
    grantCount,
  };
}

const unexpired = (g: AgentGrants.AgentGrantRow, now: number) => g.expiresAt === null || g.expiresAt > now;

export async function agentSummaries(deps: LivenessDeps, now: number = Date.now()): Promise<AgentSummary[]> {
  const r = getPersonaRegistry();
  const live = await liveCounts(deps);
  const stored = await AgentGrants.listAll("default");
  const grantCount = new Map<string, number>();
  for (const g of stored) if (unexpired(g, now)) grantCount.set(g.persona, (grantCount.get(g.persona) ?? 0) + 1);
  return Promise.all(
    agentNames(r).map(async (name) =>
      summaryOf(name, r, live, deps.role, (await listMandates(name)).length, grantCount.get(name) ?? 0),
    ),
  );
}

export async function agentDetail(
  name: string,
  deps: LivenessDeps,
  now: number = Date.now(),
): Promise<AgentSummary & { mandates: MandateView[]; grants: GrantView[] }> {
  const r = getPersonaRegistry();
  const [live, mandates, grants] = await Promise.all([liveCounts(deps), listMandates(name), grantViews(name, now)]);
  const consoleCount = grants.filter((g) => g.source === "console").length;
  return { ...summaryOf(name, r, live, deps.role, mandates.length, consoleCount), mandates, grants };
}
