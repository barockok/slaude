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
import { getPersonaRegistry, livePersona, personaDefaultModel } from "../persona/registry";
import { canStart, localDay, overAfterStart, unpricedBlock, type BudgetConfig } from "./budget";
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
  unpricedModels,
} from "./prices";
import type { ResultUsage } from "../agent/token-budget";

export const SKILL_CHECK = "skill-check" as const;

/**
 * The passes whose run is one session turn, opened before the turn and
 * finished with that turn's own usage: the post-turn skill check, and a
 * promise check (phase E, src/proactive/promises.ts). startSkillCheck and
 * finishSkillCheck take the pass (default skill-check).
 */
export type TurnPass = typeof SKILL_CHECK | "commitment";

/** What the manager calls around the post-turn skill check. */
export interface SkillCheckBudget {
  /**
   * Open a `skill-check` run. ok=false (budget) means: do not run the check.
   * `reportedModel` is the model the CLI reported for the qualifying turn (the
   * last assistant message's), a fallback when the configured one is unset or
   * unpriced. Throws on failure.
   */
  start(sessionId: string, personaId: string, reportedModel?: string): Promise<{ ok: boolean; runId?: string }>;
  /** Record the check turn's usage, per model, and end the run. Throws on failure. */
  finish(sessionId: string, runId: string, r: { usage: ModelTokens; outcome: "ok" | "error" }): Promise<void>;
}

/**
 * The ledger's agent id for a persona: the id its private brain slice is keyed
 * on. Every tenant's `default` persona resolves to the same process agent id,
 * so on a multi-tenant gateway they share one background budget and one
 * ledger (as they share the `agent-<id>` slice); give each tenant a named
 * persona with its own Slack user id to separate them.
 */
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

/** Every model a background run is configured with: SLAUDE_MODEL and each live persona's default model. */
export function configuredModels(): string[] {
  const out = [env.model() ?? ""];
  try {
    out.push(personaDefaultModel(undefined));
    for (const p of getPersonaRegistry().list()) if (p.name && p.name !== "default") out.push(personaDefaultModel(p.name));
  } catch {
    /* registry not readable yet: SLAUDE_MODEL alone */
  }
  return out;
}

/**
 * One loud boot line naming each configured model the price table has no
 * price for. Such a model still runs checks and passes, priced by the models
 * the CLI reports; a reported model with no price ends that run `error`.
 */
export function warnUnpricedModels(table: PriceTable = envPriceTable(env.priceTableRaw()), models: readonly string[] = configuredModels()): string[] {
  const missing = unpricedModels(table, models);
  if (missing.length > 0) {
    console.warn(
      `[background] WARNING: model(s) '${missing.join("', '")}' (SLAUDE_MODEL or a persona model) have no price in SLAUDE_PRICE_TABLE or the built-in table. Skill checks and background passes are priced by the model the CLI reports; if that has no price either, each run ends as error after one turn. Add an entry to SLAUDE_PRICE_TABLE.`,
    );
  }
  return missing;
}

export interface SkillCheckDeps {
  now?: () => Date;
  priceTable?: PriceTable;
  budget?: (personaId: string) => BudgetConfig;
}

const tableOf = (d: SkillCheckDeps): PriceTable => d.priceTable ?? envPriceTable(env.priceTableRaw());

const settleMetrics = (agentId: string, outcome: RunOutcome, cost: number, pass: TurnPass = SKILL_CHECK) => {
  const labels = { agent: agentId, pass };
  metric.backgroundRunsTotal.inc({ ...labels, outcome });
  if (cost > 0) metric.backgroundCostUsdTotal.inc(labels, cost);
};

/**
 * Open a skill-check run, or record why it did not start (`skipped-budget`
 * when canStart refuses; the nightly reserve applies). The run's model is the
 * configured one when it is priced, else the model the CLI reported for the
 * qualifying turn when that is, else whichever is named (or none): an unset
 * or unpriced configured model never stops the check, because finish prices
 * the check turn by the models the CLI reports in its usage (and ends the run
 * `error` when one of those has no price).
 *
 * The row (with its provisional estimate) is inserted first and the day's
 * spend re-checked after: two checks starting at once each see the other's
 * estimate, so together they never overshoot the start rule. Over → the row
 * ends `skipped-budget`.
 */
export async function startSkillCheck(
  a: { personaId: string; model: string; scope: string; reportedModel?: string; pass?: TurnPass },
  deps: SkillCheckDeps = {},
): Promise<{ ok: true; runId: string; agentId: string; estimate: number } | { ok: false; reason: "budget" | "model" }> {
  const pass = a.pass ?? SKILL_CHECK;
  const agentId = await backgroundAgentId(a.personaId);
  const now = (deps.now ?? (() => new Date()))();
  const cfg = (deps.budget ?? budgetConfigFor)(a.personaId);
  const day = localDay(now, cfg.timeZone);
  const row = { agentId, pass, scope: a.scope, day, startedAt: now.getTime() };
  const tag = `[background] agent=${agentId} pass=${pass}`;
  const skipped = () => {
    console.log(`${tag}: skipped, not enough of today's budget left`);
    settleMetrics(agentId, "skipped-budget", 0, pass);
    return { ok: false as const, reason: "budget" as const };
  };
  await sweepStaleSkillChecks(now);
  // An unpriced reported model earlier today: no further spend today.
  const unpriced = await unpricedBlock(agentId, day, tag);
  if (unpriced !== null) {
    await Runs.finish(await Runs.start({ ...row, model: null }), { tokens: ZERO_TOKENS, costUsd: 0, outcome: "error", unpricedModel: unpriced });
    settleMetrics(agentId, "error", 0, pass);
    return { ok: false, reason: "model" };
  }
  const gate = await canStart(cfg, agentId, pass, now);
  if (!gate.ok) {
    await Runs.finish(await Runs.start({ ...row, model: null }), { tokens: ZERO_TOKENS, costUsd: 0, outcome: "skipped-budget" });
    return skipped();
  }
  const table = tableOf(deps);
  const priced = (m: string | undefined): m is string => !!m && costUsd(table, m, ZERO_TOKENS) !== null;
  const reported = a.reportedModel || undefined;
  const model = priced(a.model) ? a.model : priced(reported) ? reported : a.model || reported || null;
  if (!priced(model ?? undefined)) {
    console.warn(
      `${tag}: ${a.model ? `model '${a.model}' has no price` : "no model configured"}; the check is priced by the models the CLI reports (SLAUDE_PRICE_TABLE or the built-in table)`,
    );
  }
  // The estimate is the open run's provisional cost until finish replaces it.
  const runId = await Runs.start({ ...row, model, costUsd: gate.estimate });
  if (await overAfterStart(cfg, agentId, pass, now)) {
    await Runs.finishOpen(runId, { agentId, pass }, { tokens: ZERO_TOKENS, costUsd: 0, outcome: "skipped-budget" });
    return skipped();
  }
  return { ok: true, runId, agentId, estimate: gate.estimate };
}

/** An open skill-check run older than this lost its finish (a check turn is minutes at most). */
export const SKILL_CHECK_STALE_MS = 60 * 60_000;

/**
 * End every skill-check run still open after SKILL_CHECK_STALE_MS as `error`,
 * keeping its provisional cost (the start estimate): its finish was lost (a
 * node that died, a token that could not be refreshed). Runs at the start of
 * every skill-check start; exported for the scheduler. Returns how many ended.
 */
export async function sweepStaleSkillChecks(now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const r of await Runs.listOpen(SKILL_CHECK, now.getTime() - SKILL_CHECK_STALE_MS)) {
    if (!(await Runs.finishOpen(r.id, { agentId: r.agentId, pass: SKILL_CHECK }, { tokens: r.tokens, costUsd: r.costUsd, outcome: "error" }))) continue;
    settleMetrics(r.agentId, "error", r.costUsd);
    n++;
  }
  if (n > 0) console.warn(`[background] pass=${SKILL_CHECK}: ${n} run(s) open for over an hour ended as error; their estimate stays as their cost`);
  return n;
}

/**
 * Price a check turn's usage with this process's table and end the run, only
 * while it is open and is this agent's skill-check run. A model with no price
 * is never priced at zero: its tokens are priced at the run's own model (whose
 * price start checked) and the run ends as `error`.
 */
export async function finishSkillCheck(
  a: { runId: string; agentId: string; usage: ModelTokens; outcome: "ok" | "error"; pass?: TurnPass },
  deps: SkillCheckDeps = {},
): Promise<{ ok: true; costUsd: number } | { ok: false; reason: "not-open" }> {
  const pass = a.pass ?? SKILL_CHECK;
  const run = await Runs.get(a.runId);
  if (!run || run.outcome !== null || run.agentId !== a.agentId || run.pass !== pass) return { ok: false, reason: "not-open" };
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
    // Never priced at zero: the unpriced tokens at the run's own model when
    // that has a price, else the run keeps at least its provisional estimate.
    let rest = { ...ZERO_TOKENS };
    for (const m of unpriced) rest = addTokens(rest, usage[m]!);
    const atRunModel = run.model ? costUsd(table, run.model, rest) : null;
    console.error(
      `[background] agent=${a.agentId} pass=${pass}: model '${unpriced.map((m) => m || "(none named)").join("', '")}' in the check's usage has no price: SLAUDE_PRICE_TABLE (or the built-in table) lacks it; ${atRunModel !== null ? `priced at '${run.model}'` : "the run keeps its estimate"}`,
    );
    outcome = "error";
    total = atRunModel !== null ? total + atRunModel : Math.max(total, run.costUsd);
  }
  const unpricedModel = unpriced.length > 0 ? unpriced[0] || "(none named)" : undefined;
  if (!(await Runs.finishOpen(a.runId, { agentId: a.agentId, pass }, { tokens, costUsd: total, outcome, ...(unpricedModel ? { unpricedModel } : {}) }))) {
    return { ok: false, reason: "not-open" };
  }
  settleMetrics(a.agentId, outcome, total, pass);
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
    async start(sessionId, personaId, reportedModel) {
      const row = await Sessions.findById(sessionId);
      if (!row) throw new Error(`no session row for ${sessionId}`);
      const r = await startSkillCheck(
        { personaId, model: skillCheckModel(row), scope: await o.scopeFor(sessionId), ...(reportedModel ? { reportedModel } : {}) },
        o,
      );
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

/**
 * Mono: a background turn's run (a promise check) finished straight on the
 * ledger with the turn's own usage (AgentManager sendMessage `backgroundRun`).
 */
export function ledgerTurnRun(a: { runId: string; agentId: string; pass: TurnPass } & SkillCheckDeps): { runId: string; finish(usage: ModelTokens, outcome: "ok" | "error"): Promise<void> } {
  return {
    runId: a.runId,
    async finish(usage, outcome) {
      const done = await finishSkillCheck({ runId: a.runId, agentId: a.agentId, usage, outcome, pass: a.pass }, a);
      if (!done.ok) throw new Error(`${a.pass} run ${a.runId} is not open`);
    },
  };
}
