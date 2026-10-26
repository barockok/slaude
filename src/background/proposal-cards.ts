/**
 * Proposal cards (spec §9.1 "Approvals in background passes"; Task 9 rulings
 * A, C, D): how a queued proposal reaches the one person who may decide it,
 * and what a click does.
 *
 * A proposal is a stored row, never a blocking gate: nothing waits on it.
 *   - Manager proposals are carded in the weekly digest (digest.ts), each with
 *     Approve and Reject; only the manager or the backup manager may decide.
 *   - A person's proposals (a /1on1 promotion) are posted to that person's DM
 *     once, batched per pass run, and only that person may decide them. They
 *     are never shown to anyone else, the manager included.
 *   - A skill the weekly review retired gets a Restore button in the digest
 *     (manager or backup only).
 *
 * A click is idempotent across gateway replicas: `Proposals.decide` (and
 * `claimSkillRestore`) is the one atomic transition, and only the caller it
 * returned true for runs the side effect. A second click, or a click on an
 * expired row, changes nothing.
 *
 * Approve applies the stored write through the normal gated brain path
 * (kb_memoize) with the approver as the actor and the click as the approval:
 *   team-fact         → `shared`;
 *   promote           → the target (`shared`, or the agent's own slice);
 *   skill-removal,
 *   lesson-promotion  → the decision is recorded; the operator acts in git.
 * A write that fails puts the row back to open, so it can be clicked again.
 */
import * as Proposals from "../db/proposals";
import type { Proposal } from "../db/proposals";
import { redactSecrets } from "../gateway/core/status-text";
import { clientForApp, type AppRef, type Transport } from "../gateway/core/transport";
import type { GateInput } from "../knowledge/gated-dispatch";
import { brainHandlers, type BrainToolDeps, type KbMemoizeArgs, type MemoizeTarget } from "../knowledge/mcp-tools";
import type { BrainOpCall } from "../knowledge/memory-trail";
import { resolveBrainScope } from "../knowledge/scope";
import { skillOps } from "../skills/mcp-tools";
import { proposalWrite } from "./proposal-payload";

export { proposalWrite };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Block = Record<string, any>;

/** Posts one message (a DM when `channel` is a user id) as the agent's bot, as the Slack app `app` names when known. */
/** Post a message as the agent's bot; returns where it landed (a proactive post records it, phase E). */
export type CardPost = (msg: { channel: string; app?: AppRef; text: string; blocks: Block[] }) => Promise<{ channel?: string; ts?: string } | void>;

export const NO_APP_REFUSAL = "refused: on a multi-app gateway a card goes out only as a named Slack app (app id and team)";

/**
 * The CardPost a gateway uses: the bot client of the app the message names
 * (buttons are interactivity-bound, like the gates). On a multi-app transport
 * with more than one registered app a post must name both the app id and the
 * team; a team id alone could match another persona's app, and nothing falls
 * back to the oldest one. With exactly one registered app, a post without an
 * app id goes to the transport's own resolution.
 */
export function cardPoster(t: Pick<Transport, "client" | "clientFor" | "apps">): CardPost {
  return async (msg) => {
    if (t.clientFor && !(msg.app?.apiAppId && msg.app?.teamId)) {
      // A session from before its app id was recorded: with exactly one
      // registered app, the transport's own resolution picks it (and refuses
      // a ref that does not match); with more than one, nothing is guessed.
      const registered = t.apps ? (await t.apps()).length : Infinity;
      if (registered !== 1) throw new Error(NO_APP_REFUSAL);
    }
    const r = (await clientForApp(t, msg.app).chat.postMessage({ channel: msg.channel, text: msg.text, blocks: msg.blocks })) as
      | { channel?: unknown; ts?: unknown }
      | undefined;
    return {
      ...(typeof r?.channel === "string" ? { channel: r.channel } : {}),
      ...(typeof r?.ts === "string" ? { ts: r.ts } : {}),
    };
  };
}

/** Where a click came from: the interaction's own app and workspace. */
export type ClickOrigin = { apiAppId?: string; teamId?: string };

/** A card bound to an app answers only clicks through that app and workspace. */
export function fromCardApp(row: Pick<Proposal, "slackAppId" | "slackTeamId">, from: ClickOrigin | undefined): boolean {
  if (row.slackAppId && row.slackAppId !== from?.apiAppId) return false;
  if (row.slackTeamId && row.slackTeamId !== from?.teamId) return false;
  return true;
}
const WRONG_APP = ":no_entry: this card belongs to another Slack app or workspace";

export const PROPOSAL_ACTION = /^slaude_prop:(approve|reject):(.+)$/;
export const RESTORE_ACTION = /^slaude_skill:restore:(.+)$/;
export const approveActionId = (id: string): string => `slaude_prop:approve:${id}`;
export const rejectActionId = (id: string): string => `slaude_prop:reject:${id}`;
export const restoreActionId = (id: string): string => `slaude_skill:restore:${id}`;
/** block_id of a card's button row: the one block a decision replaces. */
export const cardActionsBlockId = (id: string): string => `slaude_card:${id}`;

const PREVIEW_CHARS = 400;

/** Slack mrkdwn: `&`, `<` and `>` are markup. Model-written text is shown as text. */
export const escapeMrkdwn = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const shown = (s: string, n = PREVIEW_CHARS): string => escapeMrkdwn(clip(redactSecrets(s.trim()), n));
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const KIND_TITLE: Record<string, string> = {
  "team-fact": "Team fact for shared memory",
  promote: "Keep this beyond your private memory",
  "skill-removal": "Remove an installed skill (operator, in git)",
  "lesson-promotion": "Promote a lesson into the SOUL (operator, in git)",
};

type PageArg = KbMemoizeArgs["pages"][number];

/** The card body: what is proposed, from the payload (model-written, so escaped and clipped). */
function proposalText(p: Proposal): string {
  const pl = p.payload;
  const lines = [`*${p.toKind === "manager" && p.kind === "promote" ? "Add to shared memory" : (KIND_TITLE[p.kind] ?? p.kind)}*`];
  // Only a forwarded promotion carries a person's scope on a manager row.
  const consent = p.toKind === "manager" && p.scope.startsWith("user:") ? p.scope.slice("user:".length) : null;
  if (consent) lines.push(`_${/^[UW][A-Z0-9]+$/.test(consent) ? `<@${consent}>` : escapeMrkdwn(consent)} agreed to share this from a private conversation._`);
  const summary = str(pl.summary) ?? str(pl.reason);
  if (summary) lines.push(shown(summary, 300));
  if (p.kind === "team-fact" || p.kind === "promote") {
    const w = proposalWrite(p);
    if ("error" in w) lines.push(`_${w.error}; reject it_`);
    else {
      lines.push(`→ ${w.target === "shared" ? "shared memory" : "the agent's own memory"}`);
      for (const pg of w.pages) lines.push(`• \`${shown(pg.slug, 80)}\`: ${shown(pg.content, 300)}`);
    }
  } else if (p.kind === "skill-removal") {
    const slug = str(pl.slug);
    if (slug) lines.push(`Skill \`${shown(slug, 80)}\`${str(pl.provenance) ? ` (${shown(String(pl.provenance), 20)})` : ""}`);
  } else if (p.kind === "lesson-promotion") {
    const lesson = str(pl.lesson);
    if (lesson) lines.push(`> ${shown(lesson, 300)}`);
    const evidence = str(pl.evidence);
    if (evidence) lines.push(`Evidence: ${shown(evidence, 300)}`);
  }
  if (lines.length === 1) lines.push(shown(JSON.stringify(pl), PREVIEW_CHARS));
  return lines.join("\n");
}

/** One proposal as blocks: what it is, then Approve/Reject (open rows only). */
export function proposalBlocks(p: Proposal): Block[] {
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: proposalText(p) } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Proposed ${day(p.createdAt)} · expires ${day(p.expiresAt)}` }] },
  ];
  if (p.status === "open") {
    blocks.push({
      type: "actions",
      block_id: cardActionsBlockId(p.id),
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: approveActionId(p.id) },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: rejectActionId(p.id) },
      ],
    });
  }
  return blocks;
}

/** A retired skill as blocks, with Restore while it is still retired. */
export function retiredSkillBlocks(r: Proposal): Block[] {
  const pl = r.payload as Partial<Proposals.SkillRetiredPayload>;
  const slug = shown(String(pl.slug ?? "?"), 80);
  const restored = r.status !== "approved";
  const text = `Retired \`${slug}\` on ${day(r.createdAt)}${pl.reason ? `: ${shown(String(pl.reason), 300)}` : ""}${restored ? " _(restored)_" : ""}`;
  const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (!restored) {
    blocks.push({
      type: "actions",
      block_id: cardActionsBlockId(r.id),
      elements: [{ type: "button", text: { type: "plain_text", text: "Restore" }, action_id: restoreActionId(r.id) }],
    });
  }
  return blocks;
}

/**
 * Post a pass run's proposals for one person to that person's DM, once, as
 * one message. Only open rows addressed to that very person are posted, so a
 * proposal for anyone else can never reach this DM.
 */
export async function postPersonProposals(a: { agentId: string; userId: string; app?: AppRef; ids: readonly string[]; post: CardPost }): Promise<number> {
  const rows: Proposal[] = [];
  for (const id of a.ids) {
    const p = await Proposals.get(id);
    if (p && p.status === "open" && p.agentId === a.agentId && p.toKind === "person" && p.toUser === a.userId) rows.push(p);
  }
  if (rows.length === 0) return 0;
  const intro = rows.length === 1
    ? "I'd like to keep one thing from our private conversation somewhere beyond your own memory. Nothing is written unless you approve."
    : `I'd like to keep ${rows.length} things from our private conversations somewhere beyond your own memory. Nothing is written unless you approve.`;
  const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: intro } }];
  for (const p of rows) blocks.push({ type: "divider" }, ...proposalBlocks(p));
  await a.post({ channel: a.userId, ...(a.app ? { app: a.app } : {}), text: intro, blocks });
  // Bind the cards to the app they went out as: a click must come through it.
  if (a.app) await Proposals.stampApp(rows.map((p) => p.id), a.app).catch((e) => console.error(`[background] could not record the cards' Slack app: ${redactSecrets(e instanceof Error ? e.message : String(e))}`));
  return rows.length;
}

export interface DecideDeps {
  /** The manager and the backup manager (Slack user ids). */
  managers: () => string[];
  call: BrainOpCall;
  now: () => Date;
  /** The brain can take a write without booting (brainReady). Absent: assumed open. */
  ready?: () => boolean;
}

export type ClickResult = { ok: true; line: string } | { ok: false; text: string };

/** Who may decide a proposal: its person for a person's, the manager or backup for the manager's. */
export function mayDecide(p: Pick<Proposal, "toKind" | "toUser">, by: string, managers: readonly string[]): boolean {
  if (p.toKind === "person") return p.toUser !== null && p.toUser !== "" && by === p.toUser;
  return managers.includes(by);
}

/** Apply an approved team-fact or promote through kb_memoize, as `by`, with the click as the approval. */
async function applyWrite(p: Proposal, w: { pages: PageArg[]; target: MemoizeTarget }, by: string, deps: DecideDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  const managers = deps.managers();
  const isManager = managers.includes(by);
  // Shared memory is the team's: only the manager or backup ever writes it
  // from a card, whatever the gate below would allow.
  if (w.target === "shared" && !isManager) return { ok: false, reason: "only the manager can add to shared memory" };
  // The approver is the actor; a card is never someone's /1on1 turn, so no
  // lock and no profile: the write lands in shared or the agent's own slice.
  const gate: GateInput = { userId: by, teamId: null, interactive: false, lockedUser: null, channelTrust: "trusted", isManager, agentId: p.agentId, threadKey: null };
  const scope = resolveBrainScope({ userId: by, teamId: null, lockedUser: null, channelTrust: "trusted", isManager, kbSources: [], agentId: p.agentId });
  const d: BrainToolDeps = {
    scope: () => scope,
    gate: () => gate,
    managers: () => managers,
    requestApproval: async () => ({ approved: true, by }),
    call: deps.call,
  };
  const r = await brainHandlers.kb_memoize({ pages: w.pages, target: w.target }, d);
  return r.isError ? { ok: false, reason: r.content[0]?.text ?? "the write failed" } : { ok: true };
}

/**
 * The person approved sharing a promotion: settle it, then queue the same
 * write for the manager (scope `user:<person>` marks whose consent it
 * carries; a pass's own proposal to the manager is always scope `agent`).
 */
async function forwardToManager(p: Proposal, by: string, at: number): Promise<ClickResult> {
  if (!(await Proposals.decide(p.id, "approved", by, at))) return { ok: false, text: ":lock: this proposal was already decided" };
  try {
    const { promotedFrom: _f, ...rest } = p.payload;
    await Proposals.insert({
      agentId: p.agentId,
      kind: "promote",
      toKind: "manager",
      toUser: null,
      scope: `user:${by}`,
      payload: { ...rest, target: "shared", promotedFrom: p.id },
      createdAt: at,
      // No app stamp: the person's card went out as their thread's app, which
      // need not be the persona's own. The digest that shows this row stamps it.
    });
  } catch (e) {
    await Proposals.reopen(p.id, by, at).catch(() => {});
    console.error(`[background] proposal ${p.id}: approved by ${by} but could not be sent to the manager: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    return { ok: false, text: ":warning: that did not reach the manager. The proposal is open again; try again." };
  }
  return { ok: true, line: `Approved by <@${by}>; sent to the manager, who decides whether it goes into shared memory` };
}

/** A click on Approve or Reject: authorise, settle once, then apply. */
export async function decideProposal(a: { id: string; verb: "approve" | "reject"; by: string; from?: ClickOrigin }, deps: DecideDeps): Promise<ClickResult> {
  const p = await Proposals.get(a.id);
  if (!p || p.kind === Proposals.SKILL_RETIRED_KIND) return { ok: false, text: ":grey_question: this proposal no longer exists" };
  if (!fromCardApp(p, a.from)) return { ok: false, text: WRONG_APP };
  if (!mayDecide(p, a.by, deps.managers())) {
    return { ok: false, text: `:no_entry: <@${a.by}>, only ${p.toKind === "person" ? "the person it is for" : "the manager"} can decide this proposal. It stays open.` };
  }
  const at = deps.now().getTime();
  if (p.status !== "open" || p.expiresAt <= at) {
    return { ok: false, text: p.status === "open" || p.status === "expired" ? ":hourglass: this proposal expired" : ":lock: this proposal was already decided" };
  }
  if (a.verb === "reject") {
    if (!(await Proposals.decide(p.id, "rejected", a.by, at))) return { ok: false, text: ":lock: this proposal was already decided" };
    return { ok: true, line: `Rejected by <@${a.by}>` };
  }
  let w: { pages: PageArg[]; target: MemoizeTarget } | null = null;
  if (p.kind === "team-fact" || p.kind === "promote") {
    const parsed = proposalWrite(p);
    if ("error" in parsed) return { ok: false, text: `:warning: ${parsed.error}, so it cannot be applied; reject it instead.` };
    w = parsed;
  }
  // A person agreeing to share their content with the team is step one:
  // shared memory needs the manager, so it becomes a manager proposal.
  if (w && w.target === "shared" && p.toKind === "person") return forwardToManager(p, a.by, at);
  // Never boot the brain from a click: the proposal stays open for a later one.
  if (w && deps.ready && !deps.ready()) return { ok: false, text: ":hourglass: memory is not available right now; the proposal stays open, try again later." };
  if (!(await Proposals.decide(p.id, "approved", a.by, at))) return { ok: false, text: ":lock: this proposal was already decided" };
  if (!w) return { ok: true, line: `Approved by <@${a.by}>; the operator makes the change in git` };
  let res: { ok: true } | { ok: false; reason: string };
  try {
    res = await applyWrite(p, w, a.by, deps);
  } catch (e) {
    res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) {
    await Proposals.reopen(p.id, a.by, at).catch((e) => console.error(`[background] proposal ${p.id}: could not reopen after a failed write: ${e instanceof Error ? e.message : String(e)}`));
    console.error(`[background] proposal ${p.id}: approved by ${a.by} but the write failed: ${redactSecrets(res.reason)}`);
    return { ok: false, text: `:warning: the write did not land (${escapeMrkdwn(clip(redactSecrets(res.reason), 300))}). The proposal is open again; try again.` };
  }
  return { ok: true, line: `Approved by <@${a.by}>; written to ${w.target === "shared" ? "shared memory" : "the agent's own memory"}` };
}

/** A click on Restore: the manager or backup moves a retired skill back, once. */
export async function restoreRetiredSkill(a: { id: string; by: string; from?: ClickOrigin }, deps: Pick<DecideDeps, "managers" | "now">): Promise<ClickResult> {
  if (!deps.managers().includes(a.by)) return { ok: false, text: `:no_entry: <@${a.by}>, only the manager can restore a skill.` };
  const r = await Proposals.get(a.id);
  if (!r || r.kind !== Proposals.SKILL_RETIRED_KIND) return { ok: false, text: ":grey_question: this retirement no longer exists" };
  if (!fromCardApp(r, a.from)) return { ok: false, text: WRONG_APP };
  if (r.status !== "approved") return { ok: false, text: ":lock: this skill was already restored" };
  const pl = r.payload as Partial<Proposals.SkillRetiredPayload>;
  if (typeof pl.retiredId !== "string") return { ok: false, text: ":warning: this retirement does not name its retired copy" };
  const at = deps.now().getTime();
  if (!(await Proposals.claimSkillRestore(r.id, a.by, at))) return { ok: false, text: ":lock: this skill was already restored" };
  try {
    const persona = typeof pl.persona === "string" && pl.persona !== "default" ? pl.persona : undefined;
    const back = skillOps.restore(pl.retiredId, persona);
    console.log(`[background] agent=${r.agentId}: ${a.by} restored skill ${back.slug} from ${pl.retiredId}`);
    return { ok: true, line: `Restored \`${escapeMrkdwn(back.slug)}\` (by <@${a.by}>)` };
  } catch (e) {
    await Proposals.releaseSkillRestore(r.id, a.by, at).catch(() => {});
    return { ok: false, text: `:warning: could not restore it: ${escapeMrkdwn(clip(redactSecrets(e instanceof Error ? e.message : String(e)), 300))}` };
  }
}

/** The message's blocks with this card's button row replaced by `line`, or null when the message is not at hand. */
export function withDecision(blocks: unknown, id: string, line: string): Block[] | null {
  if (!Array.isArray(blocks)) return null;
  const bid = cardActionsBlockId(id);
  if (!blocks.some((b) => (b as Block)?.block_id === bid)) return null;
  return blocks.map((b) => ((b as Block)?.block_id === bid ? { type: "context", elements: [{ type: "mrkdwn", text: line }] } : (b as Block)));
}

const originOf = (body: unknown): ClickOrigin => {
  const b = (body ?? {}) as { api_app_id?: unknown; team?: { id?: unknown }; user?: { team_id?: unknown } };
  const teamId = typeof b.team?.id === "string" ? b.team.id : typeof b.user?.team_id === "string" ? b.user.team_id : undefined;
  return { ...(typeof b.api_app_id === "string" ? { apiAppId: b.api_app_id } : {}), ...(teamId ? { teamId } : {}) };
};

/**
 * Register the card buttons on the Slack transport. The clicker is the
 * interaction's signed `user.id`, checked as approval cards check it, before
 * anything is settled.
 */
export function registerProposalActions(t: Pick<Transport, "action">, deps: DecideDeps): void {
  const answer = async (res: ClickResult, id: string, body: { message?: { blocks?: unknown; text?: string } }, respond: (m: unknown) => Promise<void>) => {
    try {
      if (!res.ok) return void (await respond({ response_type: "ephemeral", replace_original: false, text: res.text }));
      const blocks = withDecision(body.message?.blocks, id, res.line);
      if (blocks) await respond({ replace_original: true, text: body.message?.text ?? res.line, blocks });
      else await respond({ response_type: "ephemeral", replace_original: false, text: res.line });
    } catch {
      /* the decision stands; only the card's update was lost */
    }
  };
  t.action(PROPOSAL_ACTION, async ({ ack, action, body, respond }) => {
    await ack();
    const m = action.action_id.match(PROPOSAL_ACTION);
    const by = (body as { user?: { id?: string } })?.user?.id;
    if (!m || !by) return;
    let res: ClickResult;
    try {
      res = await decideProposal({ id: m[2]!, verb: m[1] as "approve" | "reject", by, from: originOf(body) }, deps);
    } catch (e) {
      console.error(`[background] proposal ${m[2]}: click failed: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      res = { ok: false, text: ":warning: that did not work; try again" };
    }
    await answer(res, m[2]!, body, respond);
  });
  t.action(RESTORE_ACTION, async ({ ack, action, body, respond }) => {
    await ack();
    const m = action.action_id.match(RESTORE_ACTION);
    const by = (body as { user?: { id?: string } })?.user?.id;
    if (!m || !by) return;
    let res: ClickResult;
    try {
      res = await restoreRetiredSkill({ id: m[1]!, by, from: originOf(body) }, deps);
    } catch (e) {
      console.error(`[background] skill restore ${m[1]}: click failed: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      res = { ok: false, text: ":warning: that did not work; try again" };
    }
    await answer(res, m[1]!, body, respond);
  });
}
