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
import { combine, hitMessage, textHits, type RuleHit } from "../../guardrails/match";
import { auditFiring, firingEvents, type FiringApplied } from "../../guardrails/audit";
import { REDACTED } from "../../guardrails/pattern";
import { sessionGuardrails, type SessionGuardrails } from "../../guardrails/resolve";
import { cachedGuardrails, currentGuardrails, guardrailsFailure } from "../../guardrails/snapshot";
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
}

export type OutboundVerdict =
  | { action: "send"; text: string }
  | { action: "deny"; message: string }
  | { action: "hold"; text: string; message: string; slug: string; ruleId: string };

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

async function rulesFor(o: OutboundOptions): Promise<Rules> {
  const tenant = o.tenant ?? "default";
  let snap = cachedGuardrails(tenant);
  if (!snap) {
    try {
      snap = await currentGuardrails(tenant);
    } catch {
      return "unavailable";
    }
  }
  return sessionGuardrails(snap.resolved, o.persona || "default", o.channel, { version: snap.version, proseMax: env.guardrailProseMax() });
}

/** The cached rules only (sync paths: a card being built). A failed load is unavailable; none loaded yet is none. */
function cachedRulesFor(o: OutboundOptions): Rules {
  const tenant = o.tenant ?? "default";
  if (guardrailsFailure(tenant)) return "unavailable";
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
  let text = formatted;
  for (const h of d.hits) if (h.rule.action === "redact" && !h.oversize && h.rule.text?.replace) text = h.rule.text.replace(text, REDACTED);
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
    record(o, d.hits, d.deciding, "held");
    return { action: "hold", text, message: hitMessage(d.deciding), slug: d.deciding.slug, ruleId: d.deciding.rule.id };
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
export type OutboundApprover = (req: HoldRequest) => Promise<HoldDecision>;

let approver: OutboundApprover | undefined;
/** The gateway installs its ApprovalGate here. Absent: an approve is a deny. */
export function setOutboundApprover(fn: OutboundApprover | undefined): void {
  approver = fn;
}

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

/** outbound(), then post, holding the text on a card when a rule says approve. */
export async function deliver(text: string, o: OutboundOptions, io: DeliverIo): Promise<Delivered> {
  const v = await outbound(text, o);
  if (v.action === "deny") return { ok: false, error: v.message };
  if (v.action === "send") return { ok: true, ref: await io.post(v.text) };
  const placeholder = io.edit ? await io.post(WAITING_TEXT(v.slug)) : undefined;
  let d: HoldDecision;
  try {
    if (!approver) throw new Error("no approval card can be shown here");
    d = await approver({
      persona: o.persona ?? null,
      channel: o.thread!.channel,
      threadTs: o.thread!.threadTs ?? null,
      ...(o.app ? { app: o.app } : {}),
      sessionId: o.sessionId ?? null,
      summary: `Owner guardrail ${v.slug}#${v.ruleId} held a ${o.kind.replace("_", " ")}: ${v.message}`,
      detail: v.text,
      timeoutSeconds: env.guardrailApproveTimeoutSec(),
    });
  } catch (e) {
    d = { approved: false, by: "system", note: e instanceof Error ? e.message : String(e) };
  }
  if (d.approved) {
    if (placeholder && io.edit) {
      await io.edit(placeholder, v.text);
      return { ok: true, ref: placeholder, note: `held for approval, approved by <@${d.by}>` };
    }
    return { ok: true, ref: await io.post(v.text), note: `held for approval, approved by <@${d.by}>` };
  }
  const reason = d.by === "system" ? (d.note?.startsWith("timeout") ? "no approver decided in time" : (d.note ?? "not approved")) : `denied by <@${d.by}>`;
  if (placeholder && io.edit) await io.edit(placeholder, NOT_POSTED_TEXT(reason)).catch(() => {});
  return { ok: false, error: `${v.message} Not posted: ${reason}.` };
}

/** A posting site in src/ and what it carries. The outbound coverage test checks this list against the code. */
export interface OutboundSite {
  file: string;
  /** Slack write calls in the file. */
  calls: number;
  /** agent: agent-authored text, routed through outbound(); runtime: runtime UI, not covered. */
  carries: "agent" | "runtime" | "both";
  what: string;
}

/**
 * Every Slack write in src/ (chat.postMessage, chat.update, chat.postEphemeral,
 * files.uploadV2, canvases.create/edit, conversations.setTopic/setPurpose).
 */
export const OUTBOUND_SITES: readonly OutboundSite[] = [
  { file: "src/gateway/slack/surface.ts", calls: 4, carries: "both", what: "the surface: reply, edit, upload caption (agent, through deliver); sayEphemeral and runtime: true callers (todo list, connect flow) formatted only" },
  { file: "src/gateway/slack/mcp-tools.ts", calls: 11, carries: "agent", what: "the legacy slack tools: reply, edit, upload caption, post_message, post_ephemeral, canvases, topic and purpose" },
  { file: "src/gateway/slack/outbound.ts", calls: 0, carries: "agent", what: "the choke point itself" },
  { file: "src/background/proposal-cards.ts", calls: 1, carries: "both", what: "cardPoster: proactive posts (outbound in sendProactive), proposal cards (previews through outboundSync), digests and notices (runtime)" },
  { file: "src/gateway/slack/approval-gate.ts", calls: 3, carries: "runtime", what: "approval cards, their timeout edit, and a held text sent privately to approvers" },
  { file: "src/gateway/slack/permission-gate.ts", calls: 2, carries: "runtime", what: "permission cards" },
  { file: "src/gateway/core/gateway.ts", calls: 10, carries: "runtime", what: "fixed promise-check line, /remote and slash command replies, turn failure text, inbound guardrail reply, /mcp card, panel notice, feedback acknowledgement, connect card" },
];
