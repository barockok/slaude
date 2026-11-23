/**
 * The proactive post path and the pages a channel wake keeps (spec section 10):
 * `sendProactive` checks one post against the restraint rules, sends it through
 * the outbound choke point and records it; the checklist slug builder; the
 * agent-slice page helpers; the once-a-day manager notice.
 *
 * Proactive is per channel: a channel session wakes on its own (channel-wake.ts)
 * and posts through `proactive_post` (wake-tools.ts), which ends here. There is no
 * agent-level round: the summarising heartbeat that read watched MCP sources, kept
 * `self/heartbeat-journal` and routed items to the manager was removed, so what a
 * channel does on its own stays in that channel's session and checklist.
 */
import { randomUUID } from "node:crypto";
import type { AppRef } from "../gateway/core/transport";
import { outbound } from "../gateway/slack/outbound";
import * as Posts from "../db/proactive-posts";
import { claimSlot } from "../db/background-slots";
import { readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId, type BrainScope } from "../knowledge/scope";
import { proactiveFor, type ResolvedProactive } from "../soul/proactive";
import { localDay } from "../background/budget";
import type { CardPost } from "../background/proposal-cards";
import { NO_PREFS, readPingPrefs } from "./prefs";
import { checkProactive, textHash, UNCHANGED_WINDOW_MS, type Audience, type RestraintRule } from "./restraint";

/** The old per-agent checklist page: nothing reads it now, except the one-time copy to a channel's page (channel-wake.ts). */
export const HEARTBEAT_SLUG = "self/heartbeat";

/**
 * A channel's own checklist page, in the agent's slice. The only place this
 * slug is built. Lowercase: gbrain stores slugs lowercased, and `memory_save`
 * lowercases what an agent writes, so a Slack channel id (uppercase) would not
 * round-trip (field note 2026-10-26-live-smoke-test).
 */
export const channelChecklistSlug = (channelId: string): string => `${HEARTBEAT_SLUG}/${channelId.toLowerCase()}`;

export const HEARTBEAT_MAX_POSTS = 3;
/** Longest proactive post, in characters. */
export const MAX_POST_CHARS = 3000;

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


export interface ProactivePostArgs {
  audience: Audience;
  recipient?: string;
  topic: string;
  text: string;
  evidence: string;
  /** What the post rests on, recorded with it (the heartbeat round's items). */
  context?: Posts.PostContext;
}

const USER_ID = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;

/** Why a post did not go out: `cap` (this run's post limit), `invalid` (a bad argument), `restraint` (`rule` refused it), `channel` (Slack says the channel cannot take it), `failed` (Slack threw otherwise). */
type Sent =
  | { ok: true; post: Posts.ProactivePost | null }
  | { ok: false; error: string; kind: "cap" | "invalid" | "restraint" | "channel" | "failed"; rule?: RestraintRule };

/** Slack errors that will not change by retrying: the channel is not there, not joined or archived. */
const CHANNEL_ERRORS: ReadonlySet<string> = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
/** The Slack Web API error code a post threw with, if any. */
const slackError = (e: unknown): string | undefined => {
  const code = (e as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === "string" ? code : undefined;
};

/** Check, post and record one proactive post. `post` is the recorded row, or null when recording failed. */
export async function sendProactive(a: ProactivePostArgs, ctx: ProactivePostContext, state: { posts: number }): Promise<Sent> {
  const no = (error: string): Sent => ({ ok: false, error, kind: "invalid" });
  if (state.posts >= HEARTBEAT_MAX_POSTS) return { ok: false, error: `refused: at most ${HEARTBEAT_MAX_POSTS} posts per heartbeat`, kind: "cap" };
  if (!a.evidence?.trim()) return no("refused: a proactive post needs evidence (a page slug or link it rests on)");
  const raw = (a.text ?? "").trim();
  const topic = (a.topic ?? "").trim();
  if (!raw || raw.length > MAX_POST_CHARS) return no(`refused: text must be 1..${MAX_POST_CHARS} characters`);
  if (!topic) return no("refused: a proactive post needs a topic");
  const recipient = a.audience === "manager" ? (a.recipient?.trim() || ctx.managerId || "") : (a.recipient ?? "").trim();
  if (a.audience === "channel" ? !CHANNEL_ID.test(recipient) : !USER_ID.test(recipient)) {
    return no(`refused: recipient must be a ${a.audience === "channel" ? "channel id (C…/G…)" : "user id (U…/W…)"}`);
  }
  // The outbound choke point: secret masking, then the owner's reply rules.
  // Nobody is in a proactive turn, so an approve rule refuses the post.
  const v = await outbound(raw, { kind: "proactive_post", persona: ctx.personaId, channel: a.audience === "channel" ? recipient : null, unattended: true, ...(ctx.app ? { app: ctx.app } : {}) });
  if (v.action !== "send") return { ok: false, error: `refused: ${v.action === "deny" ? v.message : "this post needs an approver"}; do not rephrase it to get around the owner's guardrail`, kind: "invalid" };
  const text = v.text;
  const now = ctx.now();
  const prefs = a.audience === "channel" ? NO_PREFS : await readPingPrefs(ctx.call, ctx.app?.teamId ?? null, recipient);
  const history = await Posts.recentFor(ctx.agentId, recipient, now.getTime() - UNCHANGED_WINDOW_MS);
  const verdict = checkProactive(
    { audience: a.audience, recipient, topic, text, evidence: a.evidence },
    {
      config: ctx.config ?? ((ch) => proactiveFor(ctx.personaId, ch)),
      managerId: ctx.managerId,
      prefs,
      now,
      timeZone: ctx.timeZone,
      history,
    },
  );
  if (!verdict.ok) {
    return { ok: false, error: `refused: ${verdict.rule}; do not post this, and do not rephrase it to get around the rule`, kind: "restraint", rule: verdict.rule };
  }
  // Minted before the post: the message carries it as a marker only.
  const id = randomUUID();
  let posted: Awaited<ReturnType<CardPost>>;
  try {
    posted = await ctx.post({
      channel: recipient,
      ...(ctx.app ? { app: ctx.app } : {}),
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      metadata: { event_type: "slaude_proactive", event_payload: { post: id } },
    });
  } catch (e) {
    const code = slackError(e);
    if (code && CHANNEL_ERRORS.has(code)) return { ok: false, error: `refused: slack: ${code}`, kind: "channel" };
    throw e;
  }
  state.posts++;
  const where = posted && typeof posted === "object" ? posted : {};
  const row: Posts.ProactivePost = {
    id,
    agentId: ctx.agentId,
    audience: a.audience,
    recipient,
    topic: topic.toLowerCase(),
    textHash: textHash(text),
    evidenceHash: textHash(a.evidence),
    channelId: where.channel ?? recipient,
    messageTs: where.ts ?? null,
    teamId: ctx.app?.teamId ?? null,
    postedAt: now.getTime(),
    text,
    context: a.context ?? null,
    appId: ctx.app?.apiAppId ?? null,
  };
  // The post is out: a ledger failure is logged, never reported as a failed
  // post (the model would post it again).
  try {
    await Posts.recordPost(row);
    return { ok: true, post: row };
  } catch (e) {
    console.error(`[proactive] agent=${ctx.agentId} posted, but could not record the post: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: true, post: null };
  }
}


export const agentScope = (agentId: string): BrainScope => {
  const source = agentSourceId(agentId);
  return { clientId: agentId, sourceId: source, allowedSources: [source] };
};

/** A live page's body in the agent's slice, or "". */
export async function agentPageBody(agentId: string, call: BrainOpCall, slug: string): Promise<string> {
  const rec = readPageRecord(await getPageOrNull(call, slug, agentScope(agentId)));
  return rec && !rec.superseded ? rec.body.trim() : "";
}

const FIELD_MAX = 200;

/** One line, bounded, and no tag can open or close: model or source text going into a prompt or a page. */
export const line = (s: string | null | undefined, max = FIELD_MAX): string => (s ?? "").replace(/[\r\n]+/g, " ").replaceAll("<", "‹").trim().slice(0, max);

/**
 * One DM to the manager per reason per (persona-local) day: something is stopping
 * the agent's proactive work and only an operator can fix it. Outside restraint,
 * like a re-authorise notice: it is about the agent, not a proactive post.
 * A failure is logged, never thrown.
 */
export async function tellManagerOnce(
  r: { agentId: string; timeZone: string },
  reason: string,
  text: string,
  a: { managerId: string | null; app: AppRef | undefined; post: CardPost; at: Date; tag: string },
): Promise<void> {
  if (!a.managerId) return;
  try {
    const day = localDay(a.at, r.timeZone);
    if (!(await claimSlot(r.agentId, "heartbeat-notice", `${reason}@${day}`, a.at.getTime()))) return;
    await a.post({ channel: a.managerId, ...(a.app ? { app: a.app } : {}), text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  } catch (e) {
    console.error(`${a.tag}: could not tell the manager (${reason}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The notice for a heartbeat or a wake refused by the day's budget. */
export const OUT_OF_BUDGET_TEXT = "I'm out of today's proactive budget, so I'm skipping my recurring checks until tomorrow.";
