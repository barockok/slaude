/**
 * The heartbeat (spec §10.3, §10.4): when the SOUL enables proactiveness, a
 * timer pass reads the agent's own checklist (`agent-<id>/self/heartbeat`)
 * and runs each check. What it checks is the agent's; whether it runs is the
 * operator's (proactiveFor). It runs through the phase D pass runner, so it is
 * locked down, agent-scoped (no person's private slice is readable) and
 * budgeted (`heartbeat`, behind the nightly reserve).
 *
 * It speaks only through `proactive_post`, executed here on the gateway: the
 * restraint rules (restraint.ts) decide every post in code, the post goes out
 * as the persona's bot, and it is recorded in `proactive_posts`. At most
 * HEARTBEAT_MAX_POSTS per run; evidence is required. An absent or empty
 * checklist runs nothing and records nothing.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppRef } from "../gateway/core/transport";
import { redactSecrets } from "../gateway/core/status-text";
import * as Posts from "../db/proactive-posts";
import { readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId } from "../knowledge/scope";
import { proactiveFor, type ResolvedProactive } from "../soul/proactive";
import { renderPassPrompt } from "../background/prompts";
import { runPass, type Outcome, type PassTool, type RunnerDeps } from "../background/runner";
import type { CardPost } from "../background/proposal-cards";
import type { AgentGroup } from "../background/scheduler";
import { NO_PREFS, readPingPrefs } from "./prefs";
import { checkProactive, textHash, UNCHANGED_WINDOW_MS, type Audience } from "./restraint";

export const HEARTBEAT_SLUG = "self/heartbeat";
export const HEARTBEAT_MAX_POSTS = 3;
/** Longest proactive post, in characters. */
export const MAX_POST_CHARS = 1200;

export interface ProactivePostContext {
  agentId: string;
  personaId: string;
  /** The persona's Slack app (and team, which keys a recipient's profile). */
  app?: AppRef;
  managerId: string | null;
  post: CardPost;
  call: BrainOpCall;
  now: () => Date;
  timeZone: string;
  /** Default: proactiveFor(personaId, channelId). */
  config?: (channelId?: string) => ResolvedProactive;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface ProactivePostArgs {
  audience: Audience;
  recipient?: string;
  topic: string;
  text: string;
  evidence: string;
}

const USER_ID = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;

/** One proactive post: checked, posted, recorded. `state.posts` counts this run's posts. */
export async function proactivePost(a: ProactivePostArgs, ctx: ProactivePostContext, state: { posts: number }): Promise<ToolResult> {
  if (state.posts >= HEARTBEAT_MAX_POSTS) return err(`refused: at most ${HEARTBEAT_MAX_POSTS} posts per heartbeat`);
  if (!a.evidence?.trim()) return err("refused: a proactive post needs evidence (a page slug or link it rests on)");
  const text = redactSecrets((a.text ?? "").trim());
  const topic = (a.topic ?? "").trim();
  if (!text || text.length > MAX_POST_CHARS) return err(`refused: text must be 1..${MAX_POST_CHARS} characters`);
  if (!topic) return err("refused: a proactive post needs a topic");
  const recipient = a.audience === "manager" ? (a.recipient?.trim() || ctx.managerId || "") : (a.recipient ?? "").trim();
  if (a.audience === "channel" ? !CHANNEL_ID.test(recipient) : !USER_ID.test(recipient)) {
    return err(`refused: recipient must be a ${a.audience === "channel" ? "channel id (C…/G…)" : "user id (U…/W…)"}`);
  }
  const now = ctx.now();
  const prefs = a.audience === "channel" ? NO_PREFS : await readPingPrefs(ctx.call, ctx.app?.teamId ?? null, recipient);
  const history = await Posts.recentFor(ctx.agentId, recipient, now.getTime() - UNCHANGED_WINDOW_MS);
  const verdict = checkProactive(
    { audience: a.audience, recipient, topic, text },
    {
      config: ctx.config ?? ((ch) => proactiveFor(ctx.personaId, ch)),
      managerId: ctx.managerId,
      prefs,
      now,
      timeZone: ctx.timeZone,
      history,
    },
  );
  if (!verdict.ok) return err(`refused: ${verdict.rule}; do not post this, and do not rephrase it to get around the rule`);
  const posted = await ctx.post({
    channel: recipient,
    ...(ctx.app ? { app: ctx.app } : {}),
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
  state.posts++;
  const where = posted && typeof posted === "object" ? posted : {};
  // The post is out: a ledger failure is logged, never reported as a failed
  // post (the model would post it again).
  await Posts.recordPost({
    agentId: ctx.agentId,
    audience: a.audience,
    recipient,
    topic: topic.toLowerCase(),
    textHash: textHash(text),
    channelId: where.channel ?? recipient,
    messageTs: where.ts ?? null,
    teamId: ctx.app?.teamId ?? null,
    postedAt: now.getTime(),
  }).catch((e) => console.error(`[proactive] agent=${ctx.agentId} posted, but could not record the post: ${e instanceof Error ? e.message : String(e)}`));
  return ok({ posted: true });
}

/** The `proactive_post` pass tool, bound to one heartbeat run. */
export function proactivePostTool(ctx: ProactivePostContext): PassTool {
  const state = { posts: 0 };
  return tool(
    "proactive_post",
    `Post one proactive message (at most ${HEARTBEAT_MAX_POSTS} per heartbeat). The runtime checks the audience, quiet hours, caps, mutes and opt-ins and refuses a post that breaks any of them.`,
    {
      audience: z.enum(["manager", "person", "channel"]),
      recipient: z.string().optional().describe("User id (manager, person) or channel id. Optional for the manager."),
      topic: z.string().describe("A few words naming what this is about."),
      text: z.string().describe("One or two lines, evidence first."),
      evidence: z.string().describe("The page slug or link the claim rests on."),
    },
    (a) => proactivePost(a as ProactivePostArgs, ctx, state),
  ) as unknown as PassTool;
}

export interface HeartbeatDeps {
  runner: RunnerDeps;
  call: BrainOpCall;
  post: CardPost;
  /** The persona's manager. */
  managerId: (personaId: string) => string | null;
  /** The persona's Slack app. */
  app: (personaId: string) => Promise<AppRef | undefined>;
  /** Seam (tests): the runner. */
  run?: typeof runPass;
  config?: ProactivePostContext["config"];
}

/** The agent's checklist body, or "" when it has none. */
export async function heartbeatChecklist(agentId: string, call: BrainOpCall): Promise<string> {
  const source = agentSourceId(agentId);
  const rec = readPageRecord(await getPageOrNull(call, HEARTBEAT_SLUG, { clientId: agentId, sourceId: source, allowedSources: [source] }));
  return rec && !rec.superseded ? rec.body.trim() : "";
}

/** Run one heartbeat for an agent group; null when there was nothing to check. */
export async function runHeartbeat(r: AgentGroup & { slot: string; now: Date; signal?: AbortSignal }, deps: HeartbeatDeps): Promise<{ outcome: Outcome } | null> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat`;
  if (r.signal?.aborted) return null;
  const checklist = await heartbeatChecklist(r.agentId, deps.call);
  if (!checklist) {
    console.debug(`${tag}: no checklist; not running`);
    return null;
  }
  const managerId = deps.managerId(r.personaId);
  const app = await deps.app(r.personaId).catch(() => undefined);
  const postTool = proactivePostTool({
    agentId: r.agentId,
    personaId: r.personaId,
    ...(app ? { app } : {}),
    managerId,
    post: deps.post,
    call: deps.call,
    now: deps.runner.now,
    timeZone: r.timeZone,
    ...(deps.config ? { config: deps.config } : {}),
  });
  const prompt = renderPassPrompt("heartbeat", {
    NOW: r.slot,
    TIME_ZONE: r.timeZone,
    HEARTBEAT_SLUG,
    CHECKLIST: checklist.replace(/<\/?checklist>/gi, ""),
    MAX_POSTS: String(HEARTBEAT_MAX_POSTS),
    MANAGER: managerId ?? "none",
  });
  const res = await (deps.run ?? runPass)(
    { pass: "heartbeat", personaId: r.personaId, agentId: r.agentId, scope: { kind: "agent" }, prompt, extraTools: [postTool], ...(r.signal ? { signal: r.signal } : {}) },
    deps.runner,
  );
  return { outcome: res.outcome };
}
