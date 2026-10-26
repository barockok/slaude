/**
 * The node's skill-check budget (spec §9.3): a REST client of the gateway's
 * POST /v1/background/skill-check/start|finish. A node holds no database; the
 * gateway keeps the ledger, takes persona, agent, session and scope from the
 * job token, and prices the reported per-model token counts with its own
 * table.
 *
 * The check turn runs after the job's turn ended, on the session's last job
 * token, refreshed once through token-refresh when it has expired. Every
 * failure throws: the manager then skips the check (start) or logs the lost
 * record (finish), so a check never runs unbudgeted.
 */
import type { SkillCheckBudget } from "../background/skill-check";
import type { NodeClient } from "./client";

export function makeNodeSkillCheckBudget(deps: {
  client: Pick<NodeClient, "skillCheckStart" | "skillCheckFinish">;
  /** `call` on the session's job token (RestSessionStore.withToken); throws when none is bound. */
  withToken<T>(sessionId: string, call: (token: string) => Promise<T>): Promise<T>;
}): SkillCheckBudget {
  return {
    // The persona comes from the job token on the gateway, never from here.
    start: (sessionId) => deps.withToken(sessionId, (t) => deps.client.skillCheckStart(t)),
    finish: (sessionId, runId, r) =>
      deps.withToken(sessionId, (t) => deps.client.skillCheckFinish({ runId, outcome: r.outcome, usage: r.usage }, t)),
  };
}
