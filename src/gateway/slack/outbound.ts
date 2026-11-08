/**
 * The single outbound choke point (owner guardrails design, section 4, "Reply
 * rules"). Every path that posts text the agent wrote calls outbound() (or
 * deliver(), which also posts and holds): it formats the text the way that
 * path always has (markdown to mrkdwn, the soul's redact patterns, secret
 * masking), then applies the owner's reply rules to the text as it would be
 * posted:
 *
 *   deny     nothing is posted; the caller returns the rule's message as an error.
 *   approve  the text is held for the agent's approvers (deliver(): a
 *            "waiting for approval" placeholder, an approval card, the
 *            placeholder edited to the text on allow or to a refusal note on
 *            deny or timeout). Nobody to ask (a wake, a background pass): deny.
 *   redact   every match replaced with [REDACTED], the soul's marker.
 *   audit    posted as is; recorded.
 *
 * Every matching rule is recorded (guardrail.reply.<denied|held|redacted|audited>),
 * never with the text. With no owner rule matching, the result is exactly the
 * formatting the path had before.
 *
 * Runtime UI (permission and approval cards, the status line, slash command
 * replies, notices, the todo list) is not agent-authored and is not covered:
 * OUTBOUND_SITES below lists every Slack write in src/ and which it is, and a
 * test fails when a new one appears unclassified.
 */
import { mdToMrkdwn } from "./format";
import { redactSlack } from "./redact";
import { redactPatternsFor } from "../../soul/per-persona";
import { redactSecrets } from "../core/status-text";
import { env } from "../../config/env";
import { applyRedactions, combine, hitMessage, textHits, type RuleHit } from "../../guardrails/match";
import { auditFiring, firingEvents, type FiringApplied } from "../../guardrails/audit";
import { sessionGuardrails, type SessionGuardrails } from "../../guardrails/resolve";
import { cachedGuardrails, currentGuardrails, failedSetExists, failedSetExistsCached, guardrailsFailure } from "../../guardrails/snapshot";
import { failureText } from "../core/failure-codes";
import type { AppRef } from "../core/transport";

/** Where agent text is going. `runtime` is the runtime's own text through a surface: formatted, never ruled. */
export type OutboundKind =
  | "reply"
  | "edit"
  | "upload_caption"
  | "ephemeral"
  | "post_message"
  | "proactive_post"
  | "proposal_preview"
  | "canvas"
  | "topic"
  | "todo"
  | "runtime";

interface Profile {
  /** Markdown to Slack mrkdwn. */
  mrkdwn: boolean;
  /** The posting agent's soul redact patterns (after mrkdwn, so they see what Slack renders). */
  soul: boolean;
  /** Secret masking (src/redact). */
  secrets: boolean;
}

const MESSAGE: Profile = { mrkdwn: true, soul: true, secrets: false };
const RAW: Profile = { mrkdwn: false, soul: false, secrets: false };

/** Each path's formatting, exactly as it was before the choke point. */
export const PROFILES: Record<OutboundKind, Profile> = {
  reply: MESSAGE,
  edit: MESSAGE,
  upload_caption: MESSAGE,
  ephemeral: MESSAGE,
  post_message: MESSAGE,
  runtime: MESSAGE,
  // The wake tool converts to mrkdwn before its restraint checks; the post masks secrets.
  proactive_post: { mrkdwn: false, soul: false, secrets: true },
  // Escaped and clipped by the card after this.
  proposal_preview: { mrkdwn: false, soul: false, secrets: true },
  canvas: RAW,
  topic: RAW,
  // The todo and task trackers: the runtime renders them, the model writes their items.
  todo: MESSAGE,
};

export interface OutboundOptions {
  kind: OutboundKind;
  /** The agent posting (absent: the default agent). */
  persona?: string | null;
  /** Where the text goes (guardrails limited to channels apply only there); null when not a channel. */
  channel: string | null;
  /** The session's own thread: where a held reply's approval card goes. */
  thread?: { channel: string; threadTs?: string | null } | null;
  /** The Slack app the session posts as (the card goes out as it). */
  app?: AppRef;
  sessionId?: string | null;
  /** Nobody is in this turn (a wake, a background pass): an approve is a deny. */
  unattended?: boolean;
  tenant?: string;
  /** Epoch ms the turn must be over by (a node's job token expiry less a margin): a held text is decided before it or not posted. */
  deadline?: number;
  /** The turn's abort: a held text whose turn stops is not posted. */
  signal?: AbortSignal;
  /** An edit: the message it rewrites (a held phrase approved or denied there is remembered). */
  ref?: string;
}

/** Less time than this left: a text is not held (a card no one can answer), it is refused. */
export const MIN_HOLD_MS = 5_000;

export type OutboundVerdict =
  | { action: "send"; text: string }
  | { action: "deny"; message: string }
  | { action: "hold"; text: string; message: string; slug: string; ruleId: string; hits: RuleHit[]; deciding: RuleHit; spans: string };

/** The formatting a kind has always had. */
export function formatOutbound(text: string, kind: OutboundKind, persona?: string | null): string {
  const p = PROFILES[kind];
  let out = p.mrkdwn ? mdToMrkdwn(text) : text;
  if (p.soul) out = redactSlack(out, redactPatternsFor(persona));
  if (p.secrets) out = redactSecrets(out);
  return out;
}

/** The session guardrails for a post, or "unavailable" when the set failed to load or verify. */
type Rules = SessionGuardrails | "unavailable" | null;

/**
 * A set that exists and cannot be read or verified refuses agent posts (fail
 * closed). A deployment with no guardrail set at all (no manifest, no
 * high-water mark) is not refused when a read fails: it posts as it did
 * before guardrails existed.
 */
async function rulesFor(o: OutboundOptions): Promise<Rules> {
  const tenant = o.tenant ?? "default";
  let snap = cachedGuardrails(tenant);
  if (!snap) {
    try {
      snap = await currentGuardrails(tenant);
    } catch {
      return (await failedSetExists(tenant)) ? "unavailable" : null;
    }
  }
  return sessionGuardrails(snap.resolved, o.persona || "default", o.channel, { version: snap.version, proseMax: env.guardrailProseMax() });
}

/** The cached rules only (sync paths: a card being built). A failed load is unavailable; none loaded yet is none. */
function cachedRulesFor(o: OutboundOptions): Rules {
  const tenant = o.tenant ?? "default";
  if (guardrailsFailure(tenant)) return failedSetExistsCached(tenant) ? "unavailable" : null;
  const snap = cachedGuardrails(tenant);
  if (!snap) return null;
  return sessionGuardrails(snap.resolved, o.persona || "default", o.channel, { version: snap.version, proseMax: env.guardrailProseMax() });
}

function record(o: OutboundOptions, hits: RuleHit[], deciding: RuleHit, decided: FiringApplied): void {
  for (const e of firingEvents("reply", hits, deciding, undefined, decided, o.kind)) {
    auditFiring(e, { tenantId: o.tenant, persona: o.persona || "default", sessionId: o.sessionId ?? null, channelId: o.channel, threadTs: o.thread?.threadTs ?? null, kind: o.unattended ? "unattended" : "interactive" });
  }
}

/** Apply the owner's reply rules to formatted text. */
function judge(formatted: string, rules: Rules, o: OutboundOptions): OutboundVerdict {
  if (rules === "unavailable") return { action: "deny", message: failureText("GUARDRAILS_UNAVAILABLE") };
  const replyRules = rules?.replyRules ?? [];
  if (o.kind === "runtime" || replyRules.length === 0) return { action: "send", text: formatted };
  const d = combine(textHits(replyRules, "reply", formatted));
  if (!d) return { action: "send", text: formatted };
  // Every redact rule that matched is applied, whatever decides.
  const text = applyRedactions(d.hits, formatted);
  const oversizeRedact = d.hits.some((h) => h.rule.action === "redact" && h.oversize);
  if (d.action === "deny" || (d.action === "redact" && oversizeRedact)) {
    const deciding = d.action === "deny" ? d.deciding : d.hits.find((h) => h.rule.action === "redact" && h.oversize)!;
    record(o, d.hits, deciding, "deny");
    return { action: "deny", message: hitMessage(deciding) };
  }
  if (d.action === "approve") {
    if (o.unattended || !o.thread) {
      // Approve becomes deny: recorded as guardrail.reply.denied (design section 5).
      record(o, d.hits, d.deciding, "deny");
      return { action: "deny", message: `${hitMessage(d.deciding)} It needs an approver, and nobody is in this turn to ask, so it was not posted.` };
    }
    // Recorded by deliver(): held once a card can be asked for, denied otherwise.
    const spans = d.hits.filter((h) => h.rule.action === "approve").flatMap((h) => h.rule.text?.matches?.(formatted) ?? []).join("\u0000");
    return { action: "hold", text, message: hitMessage(d.deciding), slug: d.deciding.slug, ruleId: d.deciding.rule.id, hits: d.hits, deciding: d.deciding, spans };
  }
  record(o, d.hits, d.deciding, d.action === "redact" ? "redacted" : "audit");
  return { action: "send", text };
}

/** Format agent text for its path and apply the owner's reply rules. */
export async function outbound(text: string, o: OutboundOptions): Promise<OutboundVerdict> {
  const formatted = formatOutbound(text, o.kind, o.persona);
  if (o.kind === "runtime") return { action: "send", text: formatted };
  return judge(formatted, await rulesFor(o), o);
}

/**
 * outbound() for a path that cannot wait (a card's preview being built):
 * the cached set only, and a held text cannot wait for anyone, so approve is
 * a deny. A denied text is replaced by a note naming the guardrail.
 */
export function outboundSync(text: string, o: OutboundOptions): OutboundVerdict {
  const formatted = formatOutbound(text, o.kind, o.persona);
  return judge(formatted, cachedRulesFor(o), { ...o, unattended: true });
}

/** A held text's approval card: whoever the agent's approvers are decide it. */
export interface HoldRequest {
  /** The turn's abort: the card is cancelled with it. */
  signal?: AbortSignal;
  persona: string | null;
  channel: string;
  threadTs?: string | null;
  app?: AppRef;
  sessionId?: string | null;
  /** The card's line: the rule's message (never the text). */
  summary: string;
  /** The held text, sent privately to each approver. */
  detail: string;
  timeoutSeconds: number;
}
export type HoldDecision = { approved: boolean; by: string; note?: string };
/**
 * The card behind a held text. `approvers` is asked first, before anything is
 * posted: with nobody named, the text is refused up front (no placeholder, no
 * card that anyone in the thread could click).
 */
export interface OutboundApprover {
  approvers(req: HoldRequest): Promise<string[]>;
  ask(req: HoldRequest): Promise<HoldDecision>;
}

let approver: OutboundApprover | undefined;
/** The gateway installs its ApprovalGate here. Absent: an approve is a deny. */
export function setOutboundApprover(fn: OutboundApprover | undefined): void {
  approver = fn;
}

/** A todo or task list a rule refuses or would hold. */
export const TRACKER_HIDDEN = "**Tasks**\n_(hidden by the owner's guardrails)_";

export const WAITING_TEXT = (slug: string) => `:hourglass_flowing_sand: Waiting for approval (owner guardrail ${slug}).`;
export const NOT_POSTED_TEXT = (reason: string) => `:no_entry_sign: Not posted: ${reason}.`;

/** A post the owner's reply rules refused (deny, or a held text not approved). Its message is for the agent. */
export class OutboundRefusal extends Error {
  override name = "OutboundRefusal";
}

/** How a post ended. `note` says what happened on the way (held, approved by). */
export type Delivered = { ok: true; ref?: string; note?: string } | { ok: false; error: string };

export interface DeliverIo {
  /** Post (or, for an edit, write) the text; returns the message ref when there is one. */
  post(text: string): Promise<string | undefined>;
  /** Replace a posted message's text. Absent: the path has no message to hold in place, so nothing is posted until the card is decided. */
  edit?(ref: string, text: string): Promise<void>;
}

/**
 * What a held phrase's card decided, per session, message and rule, so a
 * streamed message (one message edited many times) is not held again at every
 * edit: an approved phrase stays approved while the matched spans are the
 * same; a denied one keeps the message on its refusal note, with no new card.
 * Bounded.
 */
const decided = new Map<string, { approved: boolean; spans: string }>();
const DECIDED_CAP = 5000;
const decidedKey = (o: OutboundOptions, ref: string, v: { slug: string; ruleId: string }) => `${o.sessionId ?? ""}\u0000${ref}\u0000${v.slug}#${v.ruleId}`;
function remember(key: string, value: { approved: boolean; spans: string }): void {
  decided.delete(key);
  decided.set(key, value);
  if (decided.size > DECIDED_CAP) decided.delete(decided.keys().next().value as string);
}
/** TEST SEAM. */
export function __resetHeldDecisionsForTests(): void {
  decided.clear();
}

const turnOver = (o: OutboundOptions, now = Date.now()) => !!o.signal?.aborted || (o.deadline !== undefined && now >= o.deadline);

/** outbound(), then post, holding the text on a card when a rule says approve. */
export async function deliver(text: string, o: OutboundOptions, io: DeliverIo): Promise<Delivered> {
  const v = await outbound(text, o);
  if (v.action === "deny") return { ok: false, error: v.message };
  if (v.action === "send") return { ok: true, ref: await io.post(v.text) };
  const refuse = (reason: string): Delivered => {
    record(o, v.hits, v.deciding, "deny");
    return { ok: false, error: `${v.message} Not posted: ${reason}.` };
  };
  // A phrase already decided in this message (a streamed edit).
  const key = o.ref ? decidedKey(o, o.ref, v) : null;
  const before = key ? decided.get(key) : undefined;
  if (before && !before.approved) return refuse("an approver already declined it in this message");
  if (before && before.approved && before.spans === v.spans) {
    record(o, v.hits, v.deciding, "audit");
    return { ok: true, ref: await io.post(v.text) };
  }
  const now = Date.now();
  const left = Math.min(env.guardrailApproveTimeoutSec() * 1000, o.deadline !== undefined ? o.deadline - now : Infinity);
  if (left < MIN_HOLD_MS || turnOver(o, now)) return refuse("not enough time left in this turn to ask an approver");
  const req: HoldRequest = {
    persona: o.persona ?? null,
    channel: o.thread!.channel,
    threadTs: o.thread!.threadTs ?? null,
    ...(o.app ? { app: o.app } : {}),
    sessionId: o.sessionId ?? null,
    summary: `Owner guardrail ${v.slug}#${v.ruleId} held a ${o.kind.replace("_", " ")}: ${v.message}`,
    detail: v.text,
    timeoutSeconds: Math.max(1, Math.floor(left / 1000)),
    ...(o.signal ? { signal: o.signal } : {}),
  };
  let named: string[];
  try {
    if (!approver) throw new Error("no approval card can be shown here");
    named = await approver.approvers(req);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  if (named.length === 0) return refuse("this agent has no approver to ask");
  record(o, v.hits, v.deciding, "held");
  const placeholder = io.edit ? await io.post(WAITING_TEXT(v.slug)) : undefined;
  let d: HoldDecision;
  try {
    d = await approver!.ask(req);
  } catch (e) {
    d = { approved: false, by: "system", note: e instanceof Error ? e.message : String(e) };
  }
  const memo = (ref: string | undefined, approved: boolean) => {
    if (ref) remember(decidedKey(o, ref, v), { approved, spans: v.spans });
  };
  // A text is never posted after its turn ended, approved or not.
  if (d.approved && turnOver(o)) d = { approved: false, by: "system", note: "the turn ended before the decision" };
  if (d.approved) {
    if (placeholder && io.edit) {
      await io.edit(placeholder, v.text);
      memo(o.ref ?? placeholder, true);
      return { ok: true, ref: placeholder, note: `held for approval, approved by <@${d.by}>` };
    }
    const ref = await io.post(v.text);
    memo(o.ref ?? ref, true);
    return { ok: true, ref, note: `held for approval, approved by <@${d.by}>` };
  }
  const reason = d.by === "system" ? (d.note?.startsWith("timeout") ? "no approver decided in time" : d.note === "aborted" ? "the turn was stopped" : (d.note ?? "not approved")) : `denied by <@${d.by}>`;
  if (placeholder && io.edit) await io.edit(placeholder, NOT_POSTED_TEXT(reason)).catch(() => {});
  memo(o.ref ?? placeholder, false);
  return { ok: false, error: `${v.message} Not posted: ${reason}.` };
}

/**
 * Every Slack write call in src/ carries a marker comment on its line, which
 * tests/gateway/outbound-sites.test.ts checks: `// outbound: ...` for a call
 * that posts agent-authored text through this module, `// runtime-ui: ...`
 * for the runtime's own UI (cards, notices, command replies), which is not
 * covered. A new write without a marker fails the test until it is
 * classified. SLACK_WRITE is what counts as a write.
 */
export const SLACK_WRITE =
  /\.(?:chat\.(?:postMessage|update|postEphemeral|scheduleMessage|meMessage|delete)|files\.(?:upload|uploadV2|delete|completeUploadExternal|getUploadURLExternal)|canvases\.(?:create|edit)|conversations\.(?:setTopic|setPurpose)|views\.(?:open|update|push|publish))\s*\(|\bapiCall\(\s*["'`](?:chat\.|files\.|views\.|canvases\.|conversations\.set)|(?<![.\w"'`])respond\(\{/;
