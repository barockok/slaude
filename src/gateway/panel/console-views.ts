/**
 * Read models behind the console API (agent platform, console part): agents
 * with their mandates and grants. Built from the live persona registry, the
 * mandate read model and the grant store; nothing here writes.
 */
import * as AgentGrants from "../../db/agent-grants";
import { effectiveGrants } from "../../access/grants";
import { listMandates } from "../../mandate";
import { getPersonaRegistry, labelsInUse, managedPersonaModel, runsOnFor, type PersonaRegistry } from "../../persona/registry";
import { listAllEnvSummaries } from "../../db/environments";
import type { Registry } from "../../queue/registry";
import { agentDefinitionView } from "./definition-view";
import { channelLabels, MAX_PER_ANSWER, plainChannelRefs, type SlackNames } from "./slack-names";
import type {
  AgentDefinitionView,
  AgentSummary,
  ConsoleGrantView,
  EnvironmentsResponse,
  GrantView,
  MandateView,
  NodePoolView,
  PersonaConsoleGrantView,
  SoulGrantView,
} from "./api-types";

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

/** Every unexpired console grant across agents (tenant `default`), with its persona. */
export async function allConsoleGrants(now: number = Date.now()): Promise<PersonaConsoleGrantView[]> {
  return (await AgentGrants.listAll("default"))
    .filter((g) => g.expiresAt === null || g.expiresAt > now)
    .map((g) => ({ ...consoleGrantView(g), persona: g.persona }));
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

/**
 * Grants with display names for their subjects (and a scoped approver's
 * channel), looked up through the agent's own app. Ids stay the key; what does
 * not resolve keeps its id alone.
 */
export async function labelGrants<G extends { subjectKind: string; subjectId: string; channelId?: string | null; persona?: string }>(
  grants: G[],
  persona: string | null,
  names: SlackNames | null,
): Promise<Array<G & { subjectLabel?: string; channelLabel?: string }>> {
  if (!names || grants.length === 0) return grants;
  const memo = new Map<string, Promise<string | null>>();
  const look = (kind: string, id: string, p: string | null): Promise<string | null> => {
    const key = `${kind}:${p ?? "-"}:${id}`;
    let v = memo.get(key);
    if (!v) {
      // Bounded per answer: past MAX_PER_ANSWER distinct ids the rest keep their ids.
      if (memo.size >= MAX_PER_ANSWER) return Promise.resolve(null);
      const ctx = { persona: p };
      v = (kind === "user" ? names.userName(id, ctx) : kind === "channel" ? names.channelLabel(id, ctx) : names.teamName(id, ctx)).catch(() => null);
      memo.set(key, v);
    }
    return v;
  };
  return Promise.all(
    grants.map(async (g) => {
      const p = g.persona ?? persona;
      const [subject, channel] = await Promise.all([look(g.subjectKind, g.subjectId, p), g.channelId ? look("channel", g.channelId, p) : null]);
      return { ...g, ...(subject ? { subjectLabel: subject } : {}), ...(channel ? { channelLabel: channel } : {}) };
    }),
  );
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
  names: SlackNames | null = null,
  opts: { canSeeValues?: boolean } = {},
): Promise<AgentSummary & { mandates: MandateView[]; grants: GrantView[]; definition: AgentDefinitionView }> {
  const r = getPersonaRegistry();
  const [live, raw, plain] = await Promise.all([liveCounts(deps), listMandates(name), grantViews(name, now)]);
  const [mandates, grants] = await Promise.all([readableMandates(raw, name, names), labelGrants(plain, name, names)]);
  const consoleCount = grants.filter((g) => g.source === "console").length;
  return { ...summaryOf(name, r, live, deps.role, mandates.length, consoleCount), mandates, grants, definition: agentDefinitionView(name, r, opts) };
}

const CHANNEL_REF = /<#([A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * Mandates as the console shows them: Slack channel references (`<#C123>`) in
 * titles, triggers and instructions become `#name` when the gateway can
 * resolve the channel, else `#C123`; a channel mandate carries its label.
 */
export async function readableMandates(mandates: MandateView[], persona: string, names: SlackNames | null): Promise<MandateView[]> {
  const ids = new Set<string>();
  for (const m of mandates) {
    if (m.channelId) ids.add(m.channelId);
    for (const t of [m.title, m.instructions, m.effective ?? "", ...m.triggers]) for (const x of t.matchAll(CHANNEL_REF)) ids.add(x[1]!);
  }
  const labels = await channelLabels(names, [...ids].map((channelId) => ({ channelId, ctx: { persona } })));
  return mandates.map((m) => {
    const label = m.channelId ? labels.get(m.channelId) : undefined;
    return {
      ...m,
      title: plainChannelRefs(m.title, labels),
      instructions: plainChannelRefs(m.instructions, labels),
      ...(m.effective !== undefined ? { effective: plainChannelRefs(m.effective, labels) } : {}),
      triggers: m.triggers.map((t) => plainChannelRefs(t, labels)),
      ...(label ? { channelLabel: label } : {}),
    };
  });
}

/**
 * Node pools: every label a live node carries or a persona runs on, with the
 * live nodes carrying it. Empty in mono (no node queue) or without a registry.
 */
export async function nodePools(
  deps: { role: "gateway" | "mono"; registry: Pick<Registry, "liveNodeDetails"> | null },
  r: PersonaRegistry = getPersonaRegistry(),
): Promise<NodePoolView[]> {
  if (deps.role === "mono" || !deps.registry) return [];
  const nodes = await deps.registry.liveNodeDetails();
  const pools = new Map<string, NodePoolView>(labelsInUse(r).map((l) => [l, { label: l, nodes: [] }]));
  for (const n of nodes) {
    for (const l of n.labels) {
      if (!pools.has(l)) pools.set(l, { label: l, nodes: [] });
      pools.get(l)!.nodes.push({ id: n.node, lastSeen: n.lastBeat });
    }
  }
  return [...pools.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The Environments page. Built field by field from the safe columns only: no
 * config, secrets or endpoints, so nothing secret can ride along.
 */
export async function environmentsView(deps: {
  role: "gateway" | "mono";
  registry: Pick<Registry, "liveNodeDetails"> | null;
}): Promise<EnvironmentsResponse> {
  const r = getPersonaRegistry();
  return {
    nodePools: await nodePools(deps, r),
    personas: agentNames(r).map((name) => ({ name, runsOn: runsOnFor(name, r) })),
    personal: (await listAllEnvSummaries()).map((e) => ({
      id: e.id,
      owner: { teamId: e.teamId, userId: e.userId },
      name: e.name,
      kind: e.kind,
      defaultDir: e.defaultDir,
      createdAt: e.createdAt,
    })),
  };
}
