import * as Runs from "../db/background-runs";

export type PassName =
  | "nightly-review"
  | "lessons-upkeep"
  | "skill-check"
  | "skill-review"
  | "quiet-moment"
  | "digest"
  | "commitment"
  | "heartbeat";

/** Estimate used when a pass has no ok run yet (USD). */
export const PASS_FLOOR: Record<PassName, number> = {
  "nightly-review": 0.1,
  "lessons-upkeep": 0.03,
  "quiet-moment": 0.05,
  "skill-review": 0.05,
  "skill-check": 0.02,
  digest: 0,
  commitment: 0.03,
  heartbeat: 0.03,
};

/** Turn cap per pass. skill-check reuses an existing turn and digest uses no model. */
export const PASS_MAX_TURNS: Partial<Record<PassName, number>> = {
  "nightly-review": 20,
  "lessons-upkeep": 6,
  "quiet-moment": 10,
  "skill-review": 12,
  heartbeat: 8,
};

export interface BudgetConfig {
  limitUsd: number;
  timeZone: string;
}

/** Persona-local YYYY-MM-DD for an instant. */
export function localDay(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Passes that must leave room for the day's nightly review while it has not run. */
const BEHIND_NIGHTLY: ReadonlySet<PassName> = new Set(["quiet-moment", "skill-review", "skill-check", "heartbeat"]);

async function estimateFor(agentId: string, pass: PassName): Promise<number> {
  // Never below the floor: a near-zero last run must not unthrottle a pass.
  return Math.max((await Runs.lastOkCost(agentId, pass)) ?? 0, PASS_FLOOR[pass]);
}

/**
 * Start rule: a pass starts only if remaining >= its estimate (last ok cost,
 * else floor). Until a nightly-review row with outcome ok, stopped-budget or
 * error exists for the day, quiet-moment / skill-review / skill-check must also
 * leave the nightly's estimate (a skipped-budget nightly keeps the reserve).
 */
export async function canStart(
  cfg: BudgetConfig,
  agentId: string,
  pass: PassName,
  now: Date,
): Promise<{ ok: true; estimate: number } | { ok: false; reason: "budget" }> {
  const day = localDay(now, cfg.timeZone);
  const estimate = await estimateFor(agentId, pass);
  let remaining = cfg.limitUsd - (await Runs.spentOn(agentId, day));
  if (BEHIND_NIGHTLY.has(pass) && !(await Runs.ranOn(agentId, "nightly-review", day))) {
    remaining -= await estimateFor(agentId, "nightly-review");
  }
  // Tolerate float noise (1 - 0.9 = 0.0999...).
  return remaining + 1e-9 >= estimate ? { ok: true, estimate } : { ok: false, reason: "budget" };
}

/**
 * The start rule's second half, once the run's row (with its estimate) is in
 * the ledger: true when the day's spend, this run and every other open run
 * included, is over the limit (less the nightly reserve, as in canStart). The
 * check before the insert alone let near-simultaneous starts each see room for
 * one and overshoot together; with the row first they see each other.
 */
export async function overAfterStart(cfg: BudgetConfig, agentId: string, pass: PassName, now: Date): Promise<boolean> {
  const day = localDay(now, cfg.timeZone);
  let remaining = cfg.limitUsd - (await Runs.spentOn(agentId, day));
  if (BEHIND_NIGHTLY.has(pass) && !(await Runs.ranOn(agentId, "nightly-review", day))) {
    remaining -= await estimateFor(agentId, "nightly-review");
  }
  return remaining < -1e-9;
}

/** agent/day pairs already logged as refused for an unpriced model (one line each per process). */
const unpricedLogged = new Set<string>();

/**
 * The reported model with no price that ended one of the agent's runs as
 * `error` today, or null. While one exists, every further background start of
 * the agent that day is refused: such a run is recorded at its estimate, its
 * real cost is unknown, and the estimate never rises (an error run is never a
 * last ok cost), so the budget would bound the number of runs, not the
 * spend. Read from the ledger, so it holds across replicas; one loud log line
 * per agent and day.
 */
export async function unpricedBlock(agentId: string, day: string, tag: string): Promise<string | null> {
  const model = await Runs.unpricedOn(agentId, day);
  if (model !== null && !unpricedLogged.has(`${agentId}/${day}`)) {
    unpricedLogged.add(`${agentId}/${day}`);
    console.error(
      `${tag}: background spend is off for the rest of ${day}: model '${model}' the CLI reported has no price (add it to SLAUDE_PRICE_TABLE)`,
    );
  }
  return model;
}
