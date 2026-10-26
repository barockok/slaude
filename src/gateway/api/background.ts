/**
 * POST /v1/background/skill-check/start|finish — the budget of a node's
 * post-turn skill check (spec §9.1, §9.3), kept on the gateway's ledger. A
 * node holds no database, so its manager's SkillCheckBudget is a REST client
 * of these two routes (src/node/background.ts).
 *
 * Everything that decides whose budget is spent comes from the verified job
 * token: the persona (and from it the agent id the brain keys `agent-<id>` on),
 * the session (whose row names the model), and the signed `runAs` (the run's
 * scope). The gateway prices with its own price table: a node reports token
 * counts per model, never a cost.
 *
 *   start   {}                                    → { ok: true, runId } | { ok: false, reason }
 *   finish  { runId, outcome, usage: {model: tokens} } → { ok: true }
 *
 * `finish` is refused (409) for a run id that is not open, or not this
 * persona's agent's skill-check run. A persona that is not live is refused
 * (PersonaNotLiveError, 409 by the router).
 */
import { z } from "zod";
import { parseRunAs } from "../../agent/credential-owner";
import { backgroundAgentId, finishSkillCheck, skillCheckModel, startSkillCheck, type SkillCheckDeps } from "../../background/skill-check";
import * as Sessions from "../../db/sessions";
import { zodIssueLine } from "../../tools/contracts/types";
import type { JobClaims } from "./auth";
import { json, notFound } from "./http";

export const BACKGROUND_OPS = ["start", "finish"] as const;
export type BackgroundOp = (typeof BACKGROUND_OPS)[number];

/** A finish body is a run id and a few models' counts. */
export const BACKGROUND_BODY_MAX_BYTES = 16 * 1024;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.object({ input: count, output: count, cache_read: count, cache_write: count }).strict();
const startBody = z.object({}).strict();
const finishBody = z
  .object({
    runId: z.string().min(1).max(64),
    outcome: z.enum(["ok", "error"]),
    // "" = the run's own model (a turn whose result named none).
    usage: z.record(z.string().max(200), tokens).refine((u) => Object.keys(u).length <= 16, "at most 16 models"),
  })
  .strict();

const personaOf = (claims: JobClaims): string => claims.persona || "default";

export async function handleSkillCheck(op: string, body: unknown, claims: JobClaims, deps: SkillCheckDeps = {}): Promise<Response> {
  try {
    if (op === "start") {
      startBody.parse(body);
      const row = await Sessions.findById(claims.session);
      if (!row) return notFound("session not found");
      const runAs = parseRunAs(claims.runAs);
      const scope = runAs?.kind === "user" ? `user:${runAs.slackUserId}` : "agent";
      const r = await startSkillCheck({ personaId: personaOf(claims), model: skillCheckModel(row), scope }, deps);
      return json(200, r.ok ? { ok: true, runId: r.runId } : { ok: false, reason: r.reason });
    }
    const b = finishBody.parse(body);
    const agentId = await backgroundAgentId(personaOf(claims));
    const r = await finishSkillCheck({ runId: b.runId, agentId, usage: b.usage, outcome: b.outcome }, deps);
    if (!r.ok) return json(409, { error: "no open skill-check run with this id for this agent" });
    return json(200, { ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return json(400, { error: `invalid input: ${zodIssueLine(e)}` });
    throw e;
  }
}
