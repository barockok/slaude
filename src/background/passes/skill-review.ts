/**
 * The weekly skill review (spec §9.1 "Skill retirement scope", §7a.5; Task 8
 * rulings A–C): one agent-scope pass a week (Sunday 04:00 persona-local, slot
 * = ISO week) audits the agent's skills against usage and the agent's own
 * memory, and retires the unused or harmful ones it authored.
 *
 * What it sees: the skills in the persona's OWN skills root (a named
 * persona's overlay, or the shared base for the default persona), as
 * metadata only — slug, name, description, provenance, usage — never a body,
 * and never another persona's overlay. Built-ins are not in any skills root
 * and a built-in's name is filtered out besides (invariant 9).
 *
 * Usage: an overlay skill counts this agent's uses; a base skill counts every
 * agent's (each persona loads the base). A skill is idle from the latest of
 * its last use, its first tracked sighting and its authored_at, so a fresh
 * install or a lost count never reads as "never used".
 *
 * Tools (this pass only): `list_skills`; `retire_skill`, refused unless
 * provenance is `agent` (checked again from disk at the call) and at most
 * MAX_RETIREMENTS per run; and the common `propose`, for a `skill-removal`
 * of an installed or bundled skill, addressed to the manager. Each retirement
 * is recorded as a settled `skill-retired` row in `proposals` for the digest.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as Proposals from "../../db/proposals";
import * as SkillUsage from "../../db/skill-usage";
import { redactSecrets } from "../../gateway/core/status-text";
import { CREDENTIAL_REFUSAL } from "../../knowledge/memory-pages";
import { discoverSkills, type Skill } from "../../skills/loader";
import { skillOps } from "../../skills/mcp-tools";
import { provenanceSources, skillProvenance, type SkillProvenance } from "../../skills/provenance";
import { usageKeysOf } from "../../skills/usage";
import { isBuiltinSkillName } from "../../soul/builtin";
import { holdsCredential, passToolId, type PassTool } from "../pass-tools";
import { renderPassPrompt } from "../prompts";
import { runPass, type Outcome } from "../runner";
import type { NightlyDeps } from "./nightly-review";
import type { AgentGroup } from "../scheduler";

export const SKILL_REVIEW = "skill-review" as const;
export const LIST_SKILLS_TOOL = "list_skills";
export const RETIRE_SKILL_TOOL = "retire_skill";
/** A skill with no load for this many days is unused. */
export const UNUSED_DAYS = 30;
/** Most skills one review retires. */
export const MAX_RETIREMENTS = 3;
const REASON_MAX = 500;
const DAY_MS = 86_400_000;

export const NOT_AGENT_REFUSAL =
  'refused: only a skill the agent wrote (provenance "agent") can be retired; for an installed or bundled skill, propose kind "skill-removal" to "manager"';
export const RETIRE_CAP_REFUSAL = `refused: this review has already retired ${MAX_RETIREMENTS} skills; leave the rest for next week`;
export const BUILTIN_REFUSAL = "refused: built-in skills are never reviewed or retired";

export type ReviewDeps = Pick<NightlyDeps, "runner" | "run">;

export interface ReviewedSkill {
  slug: string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  uses: number;
  last_used_at: string | null;
  tracked_since: string;
  authored_at: string | null;
  idle_days: number;
}

const named = (personaId: string): boolean => !!personaId && personaId !== "default";
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The persona's own skills (its overlay, or the base for the default persona), built-ins left out. */
export function ownSkills(personaId: string): Skill[] {
  const source = named(personaId) ? "persona" : "global";
  return discoverSkills(personaId).filter((s) => s.source === source && !isBuiltinSkillName(s.slug) && !isBuiltinSkillName(s.name));
}

/**
 * The review's view of the persona's own skills, at `now`. Starts tracking
 * every listed skill that has no usage row yet (first seen now).
 */
export async function reviewSkills(personaId: string, agentId: string, now: Date): Promise<ReviewedSkill[]> {
  const skills = ownSkills(personaId);
  const at = now.getTime();
  await SkillUsage.noteSeen(agentId, skills.flatMap(usageKeysOf), at);
  const usage = named(personaId) ? await SkillUsage.forAgent(agentId) : await SkillUsage.allAgents();
  const src = provenanceSources();
  return skills
    .map((s): ReviewedSkill => {
      let uses = 0;
      let last: number | null = null;
      let first = at;
      for (const key of usageKeysOf(s)) {
        const u = usage.get(key);
        if (!u) continue;
        uses += u.uses;
        if (u.lastUsedAt !== null && (last === null || u.lastUsedAt > last)) last = u.lastUsedAt;
        if (u.firstSeenAt < first) first = u.firstSeenAt;
      }
      const authored = s.authoredAt !== undefined && Number.isFinite(Date.parse(s.authoredAt)) ? Date.parse(s.authoredAt) : null;
      const since = Math.max(first, last ?? 0, authored ?? 0);
      return {
        slug: s.slug,
        name: s.name,
        description: s.description,
        provenance: skillProvenance(s, src),
        uses,
        last_used_at: iso(last),
        tracked_since: iso(first)!,
        authored_at: iso(authored),
        idle_days: Math.max(0, Math.floor((at - since) / DAY_MS)),
      };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: redactSecrets(typeof v === "string" ? v : JSON.stringify(v, null, 2)) }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text: redactSecrets(text) }], isError: true });

export interface ReviewToolContext {
  personaId: string;
  agentId: string;
  now: () => Date;
  /** Retirements so far in this run (the cap). */
  retired: Array<{ slug: string; retiredId: string }>;
}

export const reviewHandlers = {
  async list_skills(ctx: ReviewToolContext): Promise<ToolResult> {
    const skills = await reviewSkills(ctx.personaId, ctx.agentId, ctx.now());
    return ok(skills.length === 0 ? "(no skills in this agent's skills root)" : skills);
  },

  async retire_skill(p: { slug: string; reason: string }, ctx: ReviewToolContext): Promise<ToolResult> {
    const slug = typeof p.slug === "string" ? p.slug.trim() : "";
    const reason = typeof p.reason === "string" ? p.reason.trim() : "";
    if (isBuiltinSkillName(slug)) return err(BUILTIN_REFUSAL);
    if (ctx.retired.length >= MAX_RETIREMENTS) return err(RETIRE_CAP_REFUSAL);
    if (!reason) return err("refused: a retirement needs a reason");
    if (reason.length > REASON_MAX) return err(`refused: the reason is over ${REASON_MAX} characters`);
    if (holdsCredential(reason)) return err(CREDENTIAL_REFUSAL);
    // Provenance and usage are read again now, from disk and the database: never from what the model was shown.
    const skill = (await reviewSkills(ctx.personaId, ctx.agentId, ctx.now())).find((s) => s.slug === slug);
    if (!skill) return err(`refused: "${slug}" is not a skill in this agent's skills root`);
    if (skill.provenance !== "agent") return err(NOT_AGENT_REFUSAL);
    let retiredId: string;
    try {
      retiredId = skillOps.retire(slug, ctx.personaId, ctx.now()).id;
    } catch (e) {
      return err(`could not retire ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
    ctx.retired.push({ slug, retiredId });
    const at = ctx.now().getTime();
    const lastUsedAt = skill.last_used_at === null ? null : Date.parse(skill.last_used_at);
    try {
      await Proposals.recordSkillRetired({
        agentId: ctx.agentId,
        payload: { slug, retiredId, persona: ctx.personaId || "default", reason, uses: skill.uses, lastUsedAt },
        at,
      });
    } catch (e) {
      // The skill is retired either way; the digest misses this one line.
      console.error(`[background] agent=${ctx.agentId} pass=${SKILL_REVIEW}: retired ${slug} (${retiredId}) but could not record it: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log(`[background] agent=${ctx.agentId} pass=${SKILL_REVIEW}: retired ${slug} as ${retiredId}`);
    return ok({ retired: slug, id: retiredId, restorable: true });
  },
};

/** This pass's own tools on `slaude_pass`, bound to `ctx`. */
export function reviewTools(ctx: ReviewToolContext): PassTool[] {
  const tools = [
    tool(LIST_SKILLS_TOOL, "List this agent's own skills with provenance and usage (no bodies). Built-ins are never listed.", {}, () => reviewHandlers.list_skills(ctx)),
    tool(
      RETIRE_SKILL_TOOL,
      `Retire (soft delete, restorable) one skill the agent wrote: provenance "agent" only, at most ${MAX_RETIREMENTS} per review. For an installed or bundled skill use propose (kind "skill-removal", to "manager").`,
      { slug: z.string().describe("The skill's slug."), reason: z.string().describe("One sentence: unused, or the evidence it is harmful.") },
      (a) => reviewHandlers.retire_skill(a, ctx),
    ),
  ];
  return tools as unknown as PassTool[];
}

export interface ReviewResult {
  outcome: Outcome;
  retired: Array<{ slug: string; retiredId: string }>;
}

/** Run the weekly review for one agent group and slot; null when there was nothing to review. */
export async function runSkillReview(r: AgentGroup & { slot: string; signal?: AbortSignal }, deps: ReviewDeps): Promise<ReviewResult | null> {
  const tag = `[background] agent=${r.agentId} pass=${SKILL_REVIEW}`;
  if (r.signal?.aborted) {
    console.log(`${tag}: shutting down; not running`);
    return null;
  }
  if (ownSkills(r.personaId).length === 0) {
    console.log(`${tag}: persona=${r.personaId} has no skills of its own; not running`);
    return null;
  }
  const ctx: ReviewToolContext = { personaId: r.personaId, agentId: r.agentId, now: deps.runner.now, retired: [] };
  const prompt = renderPassPrompt("skill-review", {
    WEEK: r.slot,
    LIST_TOOL: passToolId(LIST_SKILLS_TOOL),
    RETIRE_TOOL: passToolId(RETIRE_SKILL_TOOL),
    UNUSED_DAYS: String(UNUSED_DAYS),
    MAX_RETIREMENTS: String(MAX_RETIREMENTS),
  });
  const res = await (deps.run ?? runPass)(
    {
      pass: SKILL_REVIEW,
      personaId: r.personaId,
      agentId: r.agentId,
      scope: { kind: "agent" },
      prompt,
      extraTools: reviewTools(ctx),
      ...(r.signal ? { signal: r.signal } : {}),
    },
    deps.runner,
  );
  return { outcome: res.outcome, retired: ctx.retired };
}
