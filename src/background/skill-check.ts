/**
 * The post-turn skill check ("auto-evolve", spec §9.1) as a budgeted
 * background pass (§9.3): before the manager pushes its check prompt, a
 * `skill-check` ledger run must start; the check turn's own usage is priced
 * and recorded on that run when the turn ends.
 *
 * The manager sees only SkillCheckBudget. Mono implements it straight on the
 * ledger (ledgerSkillCheckBudget); a node, which has no database, implements
 * it over POST /v1/background/skill-check/start|finish (src/node/background.ts),
 * and the gateway answers those routes with startSkillCheck / finishSkillCheck
 * below, pricing with ITS OWN price table (a node sends token counts per model,
 * never a cost).
 *
 * The agent id is the one the brain keys `agent-<id>` on (gateway.ts
 * brainGateFor): a named persona's Slack user id, else the process agent id
 * (SLAUDE_AGENT_ID or auth.test). A retired named persona is refused
 * (livePersona throws PersonaNotLiveError).
 */
import * as Runs from "../db/background-runs";
import type { RunOutcome } from "../db/background-runs";
import type { SessionRow } from "../db/schema";
import * as Sessions from "../db/sessions";
import { env } from "../config/env";
import { agentIdReady } from "../knowledge/agent-identity";
import { m as metric } from "../metrics";
import { livePersona, personaDefaultModel } from "../persona/registry";
import { canStart, localDay, type BudgetConfig } from "./budget";
import { budgetConfigFor } from "./config";
import {
  addTokens,
  costUsd,
  envPriceTable,
  priceByModel,
  tokensFromModelUsage,
  tokensFromUsage,
  ZERO_TOKENS,
  type ModelTokens,
  type ModelUsageRow,
  type PriceTable,
  type TokenCounts,
} from "./prices";
import type { ResultUsage } from "../agent/token-budget";

export const SKILL_CHECK = "skill-check" as const;

/** What the manager calls around the post-turn skill check. */
export interface SkillCheckBudget {
  /** Open a `skill-check` run. ok=false (budget, unpriced model) means: do not run the check. Throws on failure. */
  start(sessionId: string, personaId: string): Promise<{ ok: boolean; runId?: string }>;
  /** Record the check turn's usage, per model, and end the run. Throws on failure. */
  finish(sessionId: string, runId: string, r: { usage: ModelTokens; outcome: "ok" | "error" }): Promise<void>;
}

/** The ledger's agent id for a persona: the id its private brain slice is keyed on. */
export async function backgroundAgentId(personaId: string): Promise<string> {
  if (personaId && personaId !== "default") {
    const p = livePersona(personaId);
    if (p?.slackUserId) return p.slackUserId;
  }
  return agentIdReady();
}

/** The model a session's check turn runs on: the row's per-thread model, else the persona's default. */
export function skillCheckModel(row: Pick<SessionRow, "model" | "persona_id">): string {
  if (row.model) return row.model;
  const named = row.persona_id && row.persona_id !== "default" ? row.persona_id : undefined;
  return personaDefaultModel(named);
}

export interface SkillCheckDeps {
  now?: () => Date;
  priceTable?: PriceTable;
  budget?: (personaId: string) => BudgetConfig;
}

const tableOf = (d: SkillCheckDeps): PriceTable => d.priceTable ?? envPriceTable(env.priceTableRaw());

const settleMetrics = (agentId: string, outcome: RunOutcome, cost: number) => {
  const labels = { agent: agentId, pass: SKILL_CHECK };
  metric.backgroundRunsTotal.inc({ ...labels, outcome });
  if (cost > 0) metric.backgroundCostUsdTotal.inc(labels, cost);
};

/**
 * Open a skill-check run, or record why it did not start: `skipped-budget`
 * when canStart refuses (the nightly reserve applies), `error` when the
 * check's model has no price (never priced at zero). Each refusal is one log
 * line and one ledger row.
 */
export async function startSkillCheck(
  a: { personaId: string; model: string; scope: string },
  deps: SkillCheckDeps = {},
): Promise<{ ok: true; runId: string; agentId: string } | { ok: false; reason: "budget" | "model" }> {
  const agentId = await backgroundAgentId(a.personaId);
  const now = (deps.now ?? (() => new Date()))();
  const cfg = (deps.budget ?? budgetConfigFor)(a.personaId);
  const day = localDay(now, cfg.timeZone);
  const row = { agentId, pass: SKILL_CHECK, scope: a.scope, day, startedAt: now.getTime() };
  const tag = `[background] agent=${agentId} pass=${SKILL_CHECK}`;
  const refuse = async (outcome: RunOutcome, model: string | null) => {
    await Runs.finish(await Runs.start({ ...row, model }), { tokens: ZERO_TOKENS, costUsd: 0, outcome });
    settleMetrics(agentId, outcome, 0);
  };
  const gate = await canStart(cfg, agentId, SKILL_CHECK, now);
  if (!gate.ok) {
    console.log(`${tag}: skipped, not enough of today's budget left`);
    await refuse("skipped-budget", null);
    return { ok: false, reason: "budget" };
  }
  if (!a.model || costUsd(tableOf(deps), a.model, ZERO_TOKENS) === null) {
    console.error(
      a.model
        ? `${tag}: model '${a.model}' has no price: SLAUDE_PRICE_TABLE (or the built-in table) lacks it; not starting`
        : `${tag}: no model configured (persona model or SLAUDE_MODEL); not starting`,
    );
    await refuse("error", a.model || null);
    return { ok: false, reason: "model" };
  }
  return { ok: true, runId: await Runs.start({ ...row, model: a.model }), agentId };
}

/**
 * Price a check turn's usage with this process's table and end the run, only
 * while it is open and is this agent's skill-check run. A model with no price
 * is never priced at zero: its tokens are priced at the run's own model (whose
 * price start checked) and the run ends as `error`.
 */
export async function finishSkillCheck(
  a: { runId: string; agentId: string; usage: ModelTokens; outcome: "ok" | "error" },
  deps: SkillCheckDeps = {},
): Promise<{ ok: true; costUsd: number } | { ok: false; reason: "not-open" }> {
  const run = await Runs.get(a.runId);
  if (!run || run.outcome !== null || run.agentId !== a.agentId || run.pass !== SKILL_CHECK) return { ok: false, reason: "not-open" };
  const table = tableOf(deps);
  // "" is the caller's "the run's own model" (a turn that named none).
  const usage: ModelTokens = {};
  for (const [m, t] of Object.entries(a.usage)) {
    const key = m === "" ? (run.model ?? "") : m;
    usage[key] = usage[key] ? addTokens(usage[key]!, t) : t;
  }
  const { tokens, cost, unpriced } = priceByModel(table, usage);
  let outcome: RunOutcome = a.outcome;
  let total = cost;
  if (unpriced.length > 0) {
    console.error(
      `[background] agent=${a.agentId} pass=${SKILL_CHECK}: model '${unpriced.join("', '")}' in the check's usage has no price: SLAUDE_PRICE_TABLE (or the built-in table) lacks it; priced at '${run.model}'`,
    );
    outcome = "error";
    let rest = { ...ZERO_TOKENS };
    for (const m of unpriced) rest = addTokens(rest, usage[m]!);
    total += (run.model ? costUsd(table, run.model, rest) : null) ?? 0;
  }
  if (!(await Runs.finishOpen(a.runId, { agentId: a.agentId, pass: SKILL_CHECK }, { tokens, costUsd: total, outcome }))) {
    return { ok: false, reason: "not-open" };
  }
  settleMetrics(a.agentId, outcome, total);
  return { ok: true, costUsd: total };
}

/**
 * Mono: the budget straight on the ledger. `scopeFor` names whom the session's
 * turns run as ("agent" or "user:<id>"); the model is the session row's.
 */
export function ledgerSkillCheckBudget(o: { scopeFor(sessionId: string): Promise<string> } & SkillCheckDeps): SkillCheckBudget {
  /** runId → the agent it was opened for (one process: the run never leaves it). */
  const agents = new Map<string, string>();
  return {
    async start(sessionId, personaId) {
      const row = await Sessions.findById(sessionId);
      if (!row) throw new Error(`no session row for ${sessionId}`);
      const r = await startSkillCheck({ personaId, model: skillCheckModel(row), scope: await o.scopeFor(sessionId) }, o);
      if (!r.ok) return { ok: false };
      agents.set(r.runId, r.agentId);
      return { ok: true, runId: r.runId };
    },
    async finish(_sessionId, runId, r) {
      const agentId = agents.get(runId);
      agents.delete(runId);
      if (agentId === undefined) throw new Error(`skill-check run ${runId} was not opened here`);
      const done = await finishSkillCheck({ runId, agentId, ...r }, o);
      if (!done.ok) throw new Error(`skill-check run ${runId} is not open`);
    },
  };
}

// ---------------------------------------------------------------------------
// The check turn's usage (manager side, pure)
// ---------------------------------------------------------------------------

const nonNegative = (t: TokenCounts) => t.input >= 0 && t.output >= 0 && t.cache_read >= 0 && t.cache_write >= 0;
const isZero = (t: TokenCounts) => t.input === 0 && t.output === 0 && t.cache_read === 0 && t.cache_write === 0;
const same = (a: TokenCounts, b: TokenCounts) =>
  a.input === b.input && a.output === b.output && a.cache_read === b.cache_read && a.cache_write === b.cache_write;
const sum = (byModel: ModelTokens): TokenCounts => Object.values(byModel).reduce(addTokens, { ...ZERO_TOKENS });

/**
 * One turn's usage per model, from a streaming session's `result`. The
 * result's `usage` is that turn's own total either way (a fresh query engine
 * per input), so it decides which shape `modelUsage` has:
 *
 *   - per turn: the models' sum equals `usage` → `modelUsage` as it is;
 *   - a running total (what the pinned CLI reports, read from its code:
 *     the process-wide cost tracker): the difference from the previous
 *     result's, used when its sum equals `usage`.
 *
 * Anything else (no previous snapshot, a negative or disagreeing difference)
 * attributes the turn's `usage` to the one model in `modelUsage`, else to ""
 * (the run's own model). Never fewer tokens than `usage` reports.
 */
export function turnModelTokens(
  cur: Record<string, ModelUsageRow> | undefined,
  prev: Record<string, ModelUsageRow> | undefined,
  usage: Partial<ResultUsage> | undefined,
): ModelTokens {
  const turn = tokensFromUsage((usage ?? {}) as ResultUsage);
  const curKeys = Object.keys(cur ?? {});
  const nonZero = (byModel: ModelTokens): ModelTokens => Object.fromEntries(Object.entries(byModel).filter(([, t]) => !isZero(t)));
  if (cur && curKeys.length > 0) {
    const asIs: ModelTokens = Object.fromEntries(curKeys.map((m) => [m, tokensFromModelUsage(cur[m]!)]));
    if (same(sum(asIs), turn)) return nonZero(asIs);
    if (prev) {
      const delta: ModelTokens = {};
      let consistent = true;
      for (const m of curKeys) {
        const now = asIs[m]!;
        const before = prev[m] ? tokensFromModelUsage(prev[m]!) : ZERO_TOKENS;
        const d = { input: now.input - before.input, output: now.output - before.output, cache_read: now.cache_read - before.cache_read, cache_write: now.cache_write - before.cache_write };
        if (!nonNegative(d)) consistent = false;
        delta[m] = d;
      }
      if (consistent && same(sum(delta), turn)) return nonZero(delta);
    }
  }
  if (isZero(turn)) return {};
  const model = curKeys.length === 1 ? curKeys[0]! : "";
  return { [model]: turn };
}
