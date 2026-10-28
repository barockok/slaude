/**
 * The heartbeat round (spec §10.3, §10.4; heartbeat round spec §3, §4): when
 * the SOUL enables proactiveness, a timer round reads the agent's own
 * checklist (`agent-<id>/self/heartbeat`), its journal and its learned rules,
 * and the MCP sources the SOUL watches, read as the agent. What it checks is
 * the agent's; whether it runs, and how far it may go, is the SOUL's
 * (proactiveFor: `Enabled`, `Watch`, `Highest`).
 *
 * Triage is one locked-down, agent-scoped, budgeted pass (`heartbeat`) with
 * the memory read tools and the triage tools only: no brain write, no Slack,
 * no say over watermarks. Source content is untrusted, so the pass can at
 * most route items; code decides each one (decideItem: the rule, the model's
 * proposal and the ceiling, each only lowering the level), posts it through
 * `proactive_post`'s restraint checks, and dispatches `ask`/`act` into the
 * post's thread. Code writes the journal and advances watermarks, only when
 * the pass ended without error. At most HEARTBEAT_MAX_POSTS posts per round;
 * evidence is required. No checklist and no source runs nothing.
 */
import { randomUUID } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppRef } from "../gateway/core/transport";
import { redactSecrets } from "../gateway/core/status-text";
import { bridgeExternalMcp, type ExternalMcp } from "../gateway/core/external-mcp";
import * as Posts from "../db/proactive-posts";
import * as Watermarks from "../db/heartbeat-watermarks";
import { claimSlot } from "../db/background-slots";
import { composePage, readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId, type BrainScope } from "../knowledge/scope";
import { proactiveChannels, proactiveFor, type ResolvedProactive } from "../soul/proactive";
import { renderPassPrompt } from "../background/prompts";
import { localDay } from "../background/budget";
import { READ_ONLY_PASS_TOOLS } from "../background/pass-tools";
import { runPass, type Outcome, type PassTool, type RunnerDeps } from "../background/runner";
import type { CardPost } from "../background/proposal-cards";
import type { AgentGroup, PersonaMandates } from "../background/scheduler";
import { NO_PREFS, readPingPrefs } from "./prefs";
import { checkProactive, textHash, UNCHANGED_WINDOW_MS, type Audience, type RestraintRule } from "./restraint";
import type { Level } from "./levels";
import { JOURNAL_MAX_CHARS, JOURNAL_SLUG, loadRules, resolveLevel, type ProactiveRule } from "./rules";
import { watchableSources } from "./sources";
import type { SourceReader, SourceTool, SourceTools } from "./source-reader";
import { triageTools, type RoutedItem, type TriageState } from "./triage-tools";
import { defaultDispatchDeps, dispatchProactive, type ProactiveDispatchDeps, type ProactiveTransport } from "./dispatch";

export const HEARTBEAT_SLUG = "self/heartbeat";
export const HEARTBEAT_MAX_POSTS = 3;
/** Longest mandate line in the triage prompt, in characters (cut with an ellipsis past it). */
export const MANDATE_MAX = 600;
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
async function sendProactive(a: ProactivePostArgs, ctx: ProactivePostContext, state: { posts: number }): Promise<Sent> {
  const no = (error: string): Sent => ({ ok: false, error, kind: "invalid" });
  if (state.posts >= HEARTBEAT_MAX_POSTS) return { ok: false, error: `refused: at most ${HEARTBEAT_MAX_POSTS} posts per heartbeat`, kind: "cap" };
  if (!a.evidence?.trim()) return no("refused: a proactive post needs evidence (a page slug or link it rests on)");
  const text = redactSecrets((a.text ?? "").trim());
  const topic = (a.topic ?? "").trim();
  if (!text || text.length > MAX_POST_CHARS) return no(`refused: text must be 1..${MAX_POST_CHARS} characters`);
  if (!topic) return no("refused: a proactive post needs a topic");
  const recipient = a.audience === "manager" ? (a.recipient?.trim() || ctx.managerId || "") : (a.recipient ?? "").trim();
  if (a.audience === "channel" ? !CHANNEL_ID.test(recipient) : !USER_ID.test(recipient)) {
    return no(`refused: recipient must be a ${a.audience === "channel" ? "channel id (C…/G…)" : "user id (U…/W…)"}`);
  }
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

/** One proactive post: checked, posted, recorded. `state.posts` counts this run's posts. */
export async function proactivePost(a: ProactivePostArgs, ctx: ProactivePostContext, state: { posts: number }): Promise<ToolResult> {
  const r = await sendProactive(a, ctx, state);
  return r.ok ? ok({ posted: true }) : err(r.error);
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
  /** The persona's global mandate and each enabled channel's own, for the triage prompt. */
  mandates: (personaId: string, channelIds: readonly string[]) => PersonaMandates;
  /** The persona's Slack app. */
  app: (personaId: string) => Promise<AppRef | undefined>;
  /** The agent's own MCP sources, read as the agent. Absent: no source is read. */
  sources?: SourceReader;
  /** How ask/act turns reach their post's thread. Absent: such items are only posted. */
  proactive?: ProactiveTransport;
  /** The persona's servers as the MCP bridge serves them. Default: bridgeExternalMcp. */
  mcp?: (personaId: string) => ExternalMcp;
  /** Seam (tests): the runner. */
  run?: typeof runPass;
  config?: ProactivePostContext["config"];
  /** Seam (tests): the channels whose own Proactive is on. Default: proactiveChannels. */
  channelsOn?: (personaId: string) => string[];
  /**
   * Mono: the agent's OAuth credential lives in the CLI's own store (what
   * `/mcp global connect` writes there), which the bridge does not read and
   * must not refresh (the CLI rotates it). A source that needs auth is then
   * skipped with one warning per boot, never a DM telling the manager to
   * reconnect, which would not help.
   */
  agentOAuthInCli?: boolean;
  /** Seam (tests): dispatch deps. Default: defaultDispatchDeps. */
  dispatchDeps?: (transport: ProactiveTransport, personaId: string) => ProactiveDispatchDeps;
}

const agentScope = (agentId: string): BrainScope => {
  const source = agentSourceId(agentId);
  return { clientId: agentId, sourceId: source, allowedSources: [source] };
};

/** A live page's body in the agent's slice, or "". */
async function agentPageBody(agentId: string, call: BrainOpCall, slug: string): Promise<string> {
  const rec = readPageRecord(await getPageOrNull(call, slug, agentScope(agentId)));
  return rec && !rec.superseded ? rec.body.trim() : "";
}

/** The agent's checklist body, or "" when it has none. */
export async function heartbeatChecklist(agentId: string, call: BrainOpCall): Promise<string> {
  return agentPageBody(agentId, call, HEARTBEAT_SLUG);
}

export type Decision =
  | { action: "none"; reason?: "off" }
  | { action: "post"; audience: Audience; recipient: string; level: Level; rule: ProactiveRule | null };

/**
 * What code does with one routed item. The destination names the audience; the
 * level is the rule's (else inform), lowered by the model's proposal and the
 * ceiling for that place. `ignore`, or a channel whose proactiveness is off
 * or that has no Proactive block of its own (`channelsOn`), gives none
 * (`reason: "off"` marks the latter, which the journal records).
 */
export function decideItem(
  item: RoutedItem,
  a: { rules: ProactiveRule[]; managerId: string | null; config: (ch?: string) => ResolvedProactive; channelsOn: readonly string[] },
): Decision {
  const d = item.destination;
  const channel = CHANNEL_ID.test(d);
  const audience: Audience | null = channel ? "channel" : a.managerId && d === a.managerId ? "manager" : USER_ID.test(d) ? "person" : null;
  if (!audience) return { action: "none" };
  const cfg = channel ? a.config(d) : a.config();
  // A channel only with its own `### Proactive / Enabled: yes` (what the
  // prompt lists): untrusted items must not pick any channel the global
  // switch would otherwise allow.
  if (channel && (!cfg.enabled || !a.channelsOn.includes(d))) return { action: "none", reason: "off" };
  const { level, rule } = resolveLevel({
    rules: a.rules,
    ...(item.ruleSlug !== undefined ? { ruleSlug: item.ruleSlug } : {}),
    kind: item.kind,
    destination: d,
    proposed: item.proposedLevel,
    highest: cfg.highest,
  });
  if (level === "ignore") return { action: "none" };
  return { action: "post", audience, recipient: d, level, rule };
}

/** The agent's own posts of the last 7 days, at most this many in the prompt. */
const RECENT_POSTS_MAX = 20;
const RECENT_POSTS_MS = 7 * 86_400_000;
/** The watermark overlap: the next round re-reads this much before the last round's start. */
const WATERMARK_OVERLAP_MS = 5 * 60_000;
const EVIDENCE_MAX = 500;
const FIELD_MAX = 200;

/** One line, bounded, and no tag can open or close: model or source text going into a prompt or a page. */
const line = (s: string | null | undefined, max = FIELD_MAX): string => (s ?? "").replace(/[\r\n]+/g, " ").replaceAll("<", "‹").trim().slice(0, max);
/** A mandate on one line, cut at MANDATE_MAX with an ellipsis when it was longer. */
const mandateLine = (s: string | null | undefined): string => {
  const one = line(s, Number.MAX_SAFE_INTEGER);
  return one.length > MANDATE_MAX ? `${one.slice(0, MANDATE_MAX)}…` : one;
};
const clamp = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16) + "Z";

async function recentPostLines(agentId: string, call: BrainOpCall, now: Date): Promise<string> {
  const rows = await Posts.recentByAgent(agentId, now.getTime() - RECENT_POSTS_MS, RECENT_POSTS_MAX);
  const out: string[] = [];
  for (const p of rows) {
    // Only a channel post's outcome lives in the agent's slice; a DM's is the person's.
    const rec = readPageRecord(await getPageOrNull(call, `outcomes/proactive-${p.id}`, agentScope(agentId)).catch(() => null));
    const where = p.audience === "channel" ? `<#${p.recipient}>` : `<@${p.recipient}>`;
    out.push(`- ${iso(p.postedAt)} · ${where} · ${line(p.topic)} · ${line(rec?.meta.signal) || "no signal"}`);
  }
  return out.join("\n") || "(none)";
}

/** The journal body: the triage draft (else the last journal), then a line per item not delivered; capped. */
function journalBody(draft: string, notDelivered: readonly string[]): string {
  const tail = notDelivered.join("\n");
  const base = draft.trim();
  if (!tail) return base.slice(0, JOURNAL_MAX_CHARS);
  if (tail.length >= JOURNAL_MAX_CHARS) return tail.slice(0, JOURNAL_MAX_CHARS);
  const room = JOURNAL_MAX_CHARS - tail.length - 2;
  const head = base.slice(0, Math.max(0, room)).trimEnd();
  return head ? `${head}\n\n${tail}` : tail;
}

/** Once per rejection reason per process: watch problems are boot-time config, not per-round news. */
const warned = new Set<string>();
const warnOnce = (m: string) => {
  if (warned.has(m)) return;
  warned.add(m);
  console.warn(m);
};

/** Restraint refusals that mean "not now": the item is read again and posted once the window opens. */
const NOT_NOW: ReadonlySet<RestraintRule> = new Set<RestraintRule>(["quiet-hours", "daily-cap", "cooldown"]);

/** Run one heartbeat round for an agent group; null when there was nothing to check. */
export async function runHeartbeat(r: AgentGroup & { slot: string; now: Date; signal?: AbortSignal }, deps: HeartbeatDeps): Promise<{ outcome: Outcome } | null> {
  const tag = `[background] agent=${r.agentId} pass=heartbeat`;
  if (r.signal?.aborted) return null;
  const startedAt = deps.runner.now();
  const config = deps.config ?? ((ch?: string) => proactiveFor(r.personaId, ch));

  // 1. Load.
  const checklist = await heartbeatChecklist(r.agentId, deps.call);
  // Only watchableSources output reaches the reader: it is what keeps
  // privateServices and non-http servers out (the reader does not).
  const watched = deps.sources ? watchableSources(config().watch, (deps.mcp ?? bridgeExternalMcp)(r.personaId), warnOnce) : [];
  const sources: Array<(typeof watched)[number] & { tools: SourceTool[] }> = [];
  // Refused at listing because the agent's credential needs (re)connecting:
  // not read this round, its watermark kept, and the manager told.
  const listNeedsAuth = new Set<string>();
  for (const src of watched) {
    const listed = await deps.sources!.tools(r.personaId, src).catch((): SourceTools => ({ tools: [] }));
    if (listed.needsAuth) listNeedsAuth.add(src.server);
    else if (listed.tools.length) sources.push({ ...src, tools: listed.tools });
  }
  const managerId = deps.managerId(r.personaId);
  const app = await deps.app(r.personaId).catch(() => undefined);
  const reauth = async (servers: Iterable<string>) => {
    if (!deps.agentOAuthInCli) return tellReauth(r, servers, { managerId, app, post: deps.post, startedAt, tag });
    for (const server of servers) {
      warnOnce(
        `[proactive] persona=${r.personaId} watch "${server}": its agent connection is OAuth, which on mono lives in the agent CLI's own store; the heartbeat cannot read that store, so the source is skipped (on mono, watch a server authenticated by its config headers)`,
      );
    }
  };
  if (!checklist && !sources.length) {
    console.debug(`${tag}: no checklist and no readable source; not running`);
    await reauth(listNeedsAuth);
    return null;
  }
  const since: Record<string, number | null> = {};
  for (const s of sources) since[s.server] = await Watermarks.getSince(r.agentId, s.server);
  const journal = await agentPageBody(r.agentId, deps.call, JOURNAL_SLUG);
  const rules = await loadRules(r.agentId, deps.call);
  const channelsOn = (deps.channelsOn ?? proactiveChannels)(r.personaId);
  const m = deps.mandates(r.personaId, channelsOn);

  // 2. Triage.
  const state: TriageState = { items: [], readCalls: 0, bytes: {}, needsAuth: new Set(listNeedsAuth), failed: new Set(), journal: null };
  const extraTools: PassTool[] = triageTools(
    {
      personaId: r.personaId,
      agentId: r.agentId,
      sources,
      reader: deps.sources ?? { tools: async () => ({ tools: [] }), read: async () => ({ kind: "error", text: "no source reader" }) },
      since,
      call: deps.call,
      now: deps.runner.now,
      ...(r.signal ? { signal: r.signal } : {}),
    },
    state,
  );
  const strip = (s: string, t: string) => s.replace(new RegExp(`</?${t}>`, "gi"), "");
  const prompt = renderPassPrompt("heartbeat", {
    NOW: r.slot,
    TIME_ZONE: r.timeZone,
    HEARTBEAT_SLUG,
    CHECKLIST: strip(checklist, "checklist") || "(none)",
    JOURNAL: strip(journal, "journal") || "(none yet)",
    RULES: rules.map((x) => `- ${line(x.slug)} · ${line(x.kind)} · ${line(x.scope)} · ${x.level}`).join("\n") || "(none)",
    RECENT_POSTS: await recentPostLines(r.agentId, deps.call, startedAt),
    SOURCES: sources.map((s) => `- ${s.server}: ${since[s.server] == null ? "the last 24 hours" : `since ${iso(since[s.server]!)}`}`).join("\n") || "(none)",
    MANDATE: mandateLine(m.global) || "(not set)",
    CHANNELS_ON: channelsOn.map((c) => `- <#${c}>: ${m.channels[c] ? mandateLine(m.channels[c]) : "the global mandate"}`).join("\n") || "(none)",
    MAX_POSTS: String(HEARTBEAT_MAX_POSTS),
    MANAGER: managerId ?? "none",
  });
  const res = await (deps.run ?? runPass)(
    {
      pass: "heartbeat",
      personaId: r.personaId,
      agentId: r.agentId,
      scope: { kind: "agent" },
      prompt,
      baseTools: READ_ONLY_PASS_TOOLS,
      extraTools,
      ...(r.signal ? { signal: r.signal } : {}),
    },
    deps.runner,
  );

  // A pass cut short (stopped-budget) still decides what it routed, but it is
  // not complete: no journal, no watermark, so the next round reads its
  // sources again (restraint's "unchanged" keeps a routed item from repeating).
  // An errored pass decides nothing.
  const complete = res.outcome === "ok";
  if (res.outcome !== "error") {
    // 3. Decide, inform, dispatch.
    const ctx: ProactivePostContext = {
      agentId: r.agentId,
      personaId: r.personaId,
      ...(app ? { app } : {}),
      managerId,
      post: deps.post,
      call: deps.call,
      now: deps.runner.now,
      timeZone: r.timeZone,
      config,
    };
    const posts = { posts: 0 };
    const notDelivered: string[] = [];
    /** Sources with an item not delivered for a passing reason this round: their watermark stays, so the item is read again. */
    const undeliveredFrom = new Set<string>();
    for (const item of state.items) {
      const d = decideItem(item, { rules, managerId, config, channelsOn });
      const label = `${line(item.source, 60)}/${line(item.itemId, 100)} ${line(item.kind, 100)} → ${line(item.destination, 40)}`;
      // Transient (quiet hours, a daily cap or cooldown, the run's post cap, a failed post or dispatch): read again next round.
      const drop = (why: string, rule: ProactiveRule | null) => {
        undeliveredFrom.add(item.source);
        notDelivered.push(`Not delivered: ${label} (${rule ? line(rule.slug) : "default"})`);
        console.log(`${tag}: item ${line(item.source, 60)}/${line(item.itemId, 60)} not delivered: ${why}`);
      };
      // Terminal (a refusal that is not about timing, a switched-off place, a bad item): handled, never re-read for it.
      const notPosted = (reason: string) => {
        notDelivered.push(`Not posted: ${label} (${reason})`);
        console.log(`${tag}: item ${line(item.source, 60)}/${line(item.itemId, 60)} not posted: ${reason}`);
      };
      if (d.action === "none") {
        if (d.reason === "off") notPosted("proactiveness is off there");
        continue;
      }
      // Item dedupe, before restraint: an item already posted (an earlier or
      // stopped round, the overlap re-read, or a second destination this round)
      // is handled. Restraint's caps would otherwise refuse it as "not now" and
      // pin its source's watermark for up to a day.
      const source = line(item.source, FIELD_MAX);
      const itemId = line(item.itemId, FIELD_MAX);
      if (source && itemId && (await Posts.postedItem(r.agentId, source, itemId, startedAt.getTime() - UNCHANGED_WINDOW_MS))) {
        console.log(`${tag}: item ${line(item.source, 60)}/${line(item.itemId, 60)} already posted`);
        continue;
      }
      const summary = clamp(redactSecrets(item.summary.trim()), MAX_POST_CHARS);
      const evidence = clamp(redactSecrets(item.evidence.trim()), EVIDENCE_MAX);
      const sent = await sendProactive(
        {
          audience: d.audience,
          recipient: d.recipient,
          topic: line(item.kind, 100),
          text: summary,
          evidence,
          context: {
            source: source || null,
            itemId: itemId || null,
            summary,
            ruleSlug: d.rule?.slug ?? null,
            level: d.level,
            evidence,
          },
        },
        ctx,
        posts,
      ).catch((e): Sent => ({ ok: false, error: e instanceof Error ? e.message : String(e), kind: "failed" }));
      if (!sent.ok) {
        // "unchanged": it already went out (an earlier round, or the overlap re-read it); nothing to journal.
        if (sent.rule === "unchanged") console.log(`${tag}: item ${line(item.source, 60)}/${line(item.itemId, 60)} already posted (unchanged)`);
        else if ((sent.kind === "restraint" && !NOT_NOW.has(sent.rule!)) || sent.kind === "invalid" || sent.kind === "channel") notPosted(sent.rule ?? sent.error.replace(/^refused: /, "").slice(0, 120));
        else drop(sent.error, d.rule);
        continue;
      }
      if ((d.level === "ask" || d.level === "act") && deps.proactive) {
        if (!sent.post) {
          drop(`the ${d.level} turn was not dispatched: the post was not recorded`, d.rule);
          continue;
        }
        const ceiling = (d.audience === "channel" ? config(d.recipient) : config()).highest;
        const out = await dispatchProactive(sent.post, d.level, d.rule, ceiling, (deps.dispatchDeps ?? defaultDispatchDeps)(deps.proactive, r.personaId)).catch(
          (e) => (console.error(`${tag}: post=${sent.post!.id}: could not dispatch its ${d.level} turn: ${e instanceof Error ? e.message : String(e)}`), "failed" as const),
        );
        if (out === "no-budget" || out === "failed") drop(`the ${d.level} turn did not go out (${out})`, d.rule);
      }
    }

    // 4. Finish: the journal, then the watermarks of the sources read without error.
    let stored = complete;
    if (complete && (state.journal !== null || notDelivered.length)) {
      const page = composePage({ slug: JOURNAL_SLUG, content: redactSecrets(journalBody(state.journal ?? journal, notDelivered)), type: "heartbeat-journal" }, startedAt);
      try {
        if ("error" in page) throw new Error(page.error);
        await deps.call("put_page", { slug: JOURNAL_SLUG, content: page.content }, agentScope(r.agentId));
      } catch (e) {
        stored = false;
        console.error(`${tag}: could not store the journal; watermarks stay: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (stored) {
      const now = deps.runner.now().getTime();
      for (const s of sources) {
        // Read in this round (a read sets its byte count) and never failed or needed auth.
        if (!(s.server in state.bytes) || state.needsAuth.has(s.server) || state.failed.has(s.server) || undeliveredFrom.has(s.server)) continue;
        await Watermarks.advance(r.agentId, s.server, startedAt.getTime() - WATERMARK_OVERLAP_MS, now);
      }
    }
  }

  await reauth(state.needsAuth);
  return { outcome: res.outcome };
}

/** Re-authorising: the manager hears once per source per (persona-local) day. */
async function tellReauth(
  r: { agentId: string; timeZone: string },
  servers: Iterable<string>,
  a: { managerId: string | null; app: AppRef | undefined; post: CardPost; startedAt: Date; tag: string },
): Promise<void> {
  if (!a.managerId) return;
  const day = localDay(a.startedAt, r.timeZone);
  for (const server of servers) {
    if (!(await claimSlot(r.agentId, "heartbeat-reauth", `${server}@${day}`, a.startedAt.getTime()))) continue;
    const text = `My connection to ${server} needs re-authorising: run /mcp global connect ${server}.`;
    await a
      .post({ channel: a.managerId, ...(a.app ? { app: a.app } : {}), text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] })
      .catch((e) => console.error(`${a.tag}: could not tell the manager that ${server} needs re-authorising: ${e instanceof Error ? e.message : String(e)}`));
  }
}
