/**
 * The stale-run sweep (ruling C): a background run still open long after any
 * pass could take lost its finish (a crashed process, a dead node, a token that
 * could not be refreshed). It is ended as `error`, keeping its provisional cost
 * (the start estimate, or what its priced turns recorded), so it never counts
 * as free and never stays open in the ledger.
 *
 *   skill-check   open over SKILL_CHECK_STALE_MS (1 h: a check turn is minutes at most);
 *   every other   open over RUN_STALE_MS (2 h: a pass is bounded by its max-turns cap).
 *
 * The scheduler calls it every tick.
 */
import * as Runs from "../db/background-runs";
import { m as metric } from "../metrics";
import { SKILL_CHECK, SKILL_CHECK_STALE_MS } from "./skill-check";

/** A non-skill-check run open longer than this lost its finish. */
export const RUN_STALE_MS = 2 * 60 * 60_000;

const staleAfter = (pass: string): number => (pass === SKILL_CHECK ? SKILL_CHECK_STALE_MS : RUN_STALE_MS);

/** End every stale open run as `error`. Returns how many ended. */
export async function sweepStaleRuns(now: Date = new Date()): Promise<number> {
  const t = now.getTime();
  const ended = new Map<string, number>();
  for (const r of await Runs.listOpenAll(t - Math.min(SKILL_CHECK_STALE_MS, RUN_STALE_MS))) {
    if (r.startedAt >= t - staleAfter(r.pass)) continue;
    if (!(await Runs.finishOpen(r.id, { agentId: r.agentId, pass: r.pass }, { tokens: r.tokens, costUsd: r.costUsd, outcome: "error" }))) continue;
    const labels = { agent: r.agentId, pass: r.pass };
    metric.backgroundRunsTotal.inc({ ...labels, outcome: "error" });
    if (r.costUsd > 0) metric.backgroundCostUsdTotal.inc(labels, r.costUsd);
    ended.set(r.pass, (ended.get(r.pass) ?? 0) + 1);
  }
  let n = 0;
  for (const [pass, k] of ended) {
    n += k;
    console.warn(`[background] pass=${pass}: ${k} run(s) open for over ${staleAfter(pass) / 3600_000} h ended as error; their recorded cost stays`);
  }
  return n;
}
