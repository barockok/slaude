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
 * counts per model, never a cost. A start may name the model the CLI reported
 * for the qualifying turn: only a fallback for the run's label when the
 * session's configured model is unset or unpriced; finish still prices the
 * reported usage.
 *
 *   start   { model? }                            → { ok: true, runId } | { ok: false, reason }
 *   finish  { runId, outcome, usage: {model: tokens} } → { ok: true }
 *
 * POST /v1/background/skill-usage {skill} counts one use of a skill by the
 * token persona's agent (spec §9.1), for the weekly skill review. The node
 * sends it fire-and-forget after a successful `Skill` call.
 *
 * `finish` is refused (409) for a run id that is not open, or not this
 * persona's agent's skill-check run. A persona that is not live is refused
 * (PersonaNotLiveError, 409 by the router).
 */
import { z } from "zod";
import { parseRunAs } from "../../agent/credential-owner";
import { backgroundAgentId, finishSkillCheck, skillCheckModel, startSkillCheck, type SkillCheckDeps } from "../../background/skill-check";
import * as Sessions from "../../db/sessions";
import * as SkillUsage from "../../db/skill-usage";
import { SKILL_KEY_MAX, skillUsageKey } from "../../skills/usage";
import { zodIssueLine } from "../../tools/contracts/types";
import type { JobClaims } from "./auth";
import { json, notFound } from "./http";

export const BACKGROUND_OPS = ["start", "finish"] as const;
export type BackgroundOp = (typeof BACKGROUND_OPS)[number];

/** A finish body is a run id and a few models' counts. */
export const BACKGROUND_BODY_MAX_BYTES = 16 * 1024;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.object({ input: count, output: count, cache_read: count, cache_write: count }).strict();
/** A model id as the CLI reports it (`claude-…`, `anthropic/claude-…`, a dated snapshot). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const startBody = z.object({ model: z.string().regex(MODEL_ID).optional() }).strict();
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
      const b = startBody.parse(body);
      const row = await Sessions.findById(claims.session);
      if (!row) return notFound("session not found");
      const runAs = parseRunAs(claims.runAs);
      const scope = runAs?.kind === "user" ? `user:${runAs.slackUserId}` : "agent";
      const r = await startSkillCheck(
        { personaId: personaOf(claims), model: skillCheckModel(row), scope, ...(b.model ? { reportedModel: b.model } : {}) },
        deps,
      );
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

const usageBody = z.object({ skill: z.string().min(1).max(SKILL_KEY_MAX + 1) }).strict();

/** POST /v1/background/skill-usage: one use, by the job token persona's agent. */
export async function handleSkillUsage(body: unknown, claims: JobClaims, now: () => number = Date.now): Promise<Response> {
  let skill: string;
  try {
    skill = usageBody.parse(body).skill;
  } catch (e) {
    if (e instanceof z.ZodError) return json(400, { error: `invalid input: ${zodIssueLine(e)}` });
    throw e;
  }
  const key = skillUsageKey(skill);
  if (!key) return json(400, { error: "invalid input: skill: not a skill name" });
  const agentId = await backgroundAgentId(personaOf(claims));
  await SkillUsage.record(agentId, key, now());
  return json(200, { ok: true });
}
