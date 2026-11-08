/**
 * The console's Test box (design section 6, phase B): what the owner's
 * guardrails would do with one event for one agent in one channel, without
 * doing it. Pure: no audit row, no card, no delivery mark.
 *
 * It runs the runtime's own code, not a copy: sessionGuardrails builds the
 * agent's effective rules exactly as a session boot does, and toolHits,
 * textHits, combine, applyRedactions, toolTriggered and inboundTriggered are
 * the functions the PreToolUse hook (hooks.ts), the outbound choke point
 * (gateway/slack/outbound.ts) and the inbound check (gateway/core/
 * owner-guardrails.ts) call. A reply is formatted by the caller with the
 * outbound formatter first, as a real reply is.
 *
 * An unsaved draft of one guardrail can stand in for its stored text (or be
 * added when it is new), so an owner can try a rule before saving it.
 */
import { parseGuardrail } from "./format";
import { applyRedactions, combine, hitMessage, inboundDenyMessage, textHits, toolHits, type Decision, type RuleHit } from "./match";
import { appliesTo, inboundTriggered, resolveDocs, sessionGuardrails, toolTriggered, type GuardrailDoc, type OnMatchGuidance, type ResolvedGuardrail } from "./resolve";

export type TestEvent =
  | { kind: "tool"; tool: string; input: unknown }
  | { kind: "reply"; text: string }
  | { kind: "inbound"; text: string };

export interface TestHit {
  slug: string;
  ruleId: string;
  action: RuleHit["rule"]["action"];
  /** The message the runtime would show for this rule. */
  message: string;
  /** Counted only because the input or text is too large to check (fail closed). */
  oversize: boolean;
  deciding: boolean;
  /** The rule comes from the unsaved draft. */
  draft: boolean;
}

export interface TestResult {
  agent: string;
  channel: string | null;
  kind: TestEvent["kind"];
  /** Enforced rules of this kind in the agent's effective set for the channel. */
  rulesChecked: number;
  hits: TestHit[];
  /** The strictest action (deny > approve > redact > audit), or null when nothing matched. */
  decision: { action: RuleHit["rule"]["action"]; slug: string; ruleId: string; message: string; oversize: boolean } | null;
  /** What the runtime does with the event, in one sentence. */
  outcome: string;
  /** A reply as it would be posted (redactions applied); absent when it would not be posted. */
  posted?: string;
  /** Any hit counted only because something was too large to check. */
  tooLarge: boolean;
  guidance: {
    /** Always-loaded Guidance in this agent's prompt here. */
    always: Array<{ slug: string; name: string; chars: number }>;
    /** Always-loaded Guidance left out by the prose cap (the one that tips it, and any after it that do not fit). */
    skipped: Array<{ slug: string; name: string; chars: number }>;
    /** On-match Guidance whose trigger this event matches: delivered once per session. */
    delivered: Array<{ slug: string; name: string; via: "tool" | "inbound" }>;
    /** On-match Guidance in the prompt index only (its trigger did not match). */
    indexed: Array<{ slug: string; name: string }>;
    proseChars: number;
    proseMax: number;
  };
  /** The draft that was tested in place of its stored text, with its validation. */
  draft: { slug: string; errors: string[]; blocking: string[]; replaced: boolean } | null;
}

export interface TestOptions {
  agent: string;
  channel: string | null;
  version: number;
  proseMax: number;
  draft?: { slug: string; md: string } | null;
}

/** The stored set with a draft in place of (or added beside) its stored text. */
export function withDraft(resolved: readonly ResolvedGuardrail[], draft: { slug: string; md: string }): { resolved: ResolvedGuardrail[]; replaced: boolean } {
  const prev = resolved.find((g) => g.slug === draft.slug);
  const doc: GuardrailDoc = prev
    ? { ...prev.doc, md: draft.md }
    : { slug: draft.slug, md: draft.md, source: "console", override: false, behindSource: false, enabled: true };
  const [parsed] = resolveDocs([doc]);
  return { resolved: [...resolved.filter((g) => g.slug !== draft.slug), parsed!], replaced: !!prev };
}

function outcomeOf(e: TestEvent, d: Decision | null, delivered: OnMatchGuidance[]): string {
  if (e.kind === "tool") {
    if (d?.action === "deny") return `Refused: ${hitMessage(d.deciding)}`;
    const deliver = delivered.length ? `Refused once to hand the model ${delivered.map((o) => o.name).join(", ")} (delivery, not a decision), then on the retry: ` : "";
    if (!d) return `${deliver}${deliver ? "allowed" : "Allowed"} (no enforced rule matched).`;
    if (d.action === "approve") return `${deliver}${deliver ? "held" : "Held"} on an approval card for the requester or an approver; refused on a timeout, in a wake or a background pass, or with nobody to ask.`;
    return `${deliver}${deliver ? "allowed" : "Allowed"} and recorded in the audit trail.`;
  }
  if (e.kind === "reply") {
    if (!d) return "Posted as is (no enforced rule matched).";
    if (d.action === "deny") return `Not posted: ${hitMessage(d.deciding)}`;
    if (d.action === "approve") return "Held: a placeholder is posted and the text goes privately to an approver. With nobody to ask (no named approver, a wake, a proactive post, a proposal preview) it is not posted.";
    if (d.action === "redact") return "Posted with every match replaced by [REDACTED].";
    return "Posted and recorded in the audit trail.";
  }
  if (!d) return "Passed on to the agent (no enforced rule matched).";
  if (d.action === "deny") return `Not passed on. The person is told: ${inboundDenyMessage(d.deciding)}`;
  return "Passed on to the agent and recorded in the audit trail.";
}

/** Evaluate one event against the effective set of `opts.agent` in `opts.channel`. */
export function evaluateGuardrails(stored: readonly ResolvedGuardrail[], event: TestEvent, opts: TestOptions): TestResult {
  let resolved: readonly ResolvedGuardrail[] = stored;
  let draft: TestResult["draft"] = null;
  if (opts.draft) {
    const p = parseGuardrail(opts.draft.slug, opts.draft.md);
    const w = withDraft(stored, opts.draft);
    resolved = w.resolved;
    draft = { slug: opts.draft.slug, errors: p.errors, blocking: p.blocking, replaced: w.replaced };
  }
  const g = sessionGuardrails(resolved, opts.agent, opts.channel, { version: opts.version, proseMax: opts.proseMax });
  let d: Decision | null;
  let rulesChecked: number;
  let delivered: OnMatchGuidance[] = [];
  let via: "tool" | "inbound" = "tool";
  if (event.kind === "tool") {
    rulesChecked = g.toolRules.length;
    d = combine(toolHits(g.toolRules, [event.tool], event.input));
    delivered = toolTriggered(g, event.tool, opts.channel);
  } else if (event.kind === "reply") {
    rulesChecked = g.replyRules.length;
    d = combine(textHits(g.replyRules, "reply", event.text));
  } else {
    rulesChecked = g.inboundRules.length;
    d = combine(textHits(g.inboundRules, "inbound", event.text));
    delivered = inboundTriggered(g, event.text, opts.channel);
    via = "inbound";
  }
  const hits: TestHit[] = (d?.hits ?? []).map((h) => ({
    slug: h.slug,
    ruleId: h.rule.id,
    action: h.rule.action,
    message: event.kind === "inbound" && h.rule.action === "deny" ? inboundDenyMessage(h) : hitMessage(h),
    oversize: !!h.oversize,
    deciding: h === d!.deciding,
    draft: !!draft && h.slug === draft.slug,
  }));
  let posted: string | undefined;
  if (event.kind === "reply") {
    const redactedDeny = d?.action === "redact" && d.hits.some((h) => h.rule.action === "redact" && h.oversize);
    if (!d || d.action === "redact" || d.action === "audit") posted = redactedDeny ? undefined : applyRedactions(d?.hits ?? [], event.text);
  }
  // The always-loaded prose sessionGuardrails took into the prompt: what applies here, minus what the cap left out.
  const always = resolved
    .filter((r) => appliesTo(r, opts.agent, opts.channel) && r.meta!.load === "always" && r.prose && !g.skipped.some((s) => s.slug === r.slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((r) => ({ slug: r.slug, name: r.meta!.name, chars: r.prose.length }));
  const deliveredSlugs = new Set(delivered.map((o) => o.slug));
  return {
    agent: opts.agent,
    channel: opts.channel,
    kind: event.kind,
    rulesChecked,
    hits,
    decision: d ? { action: d.action, slug: d.deciding.slug, ruleId: d.deciding.rule.id, message: hits.find((h) => h.deciding)!.message, oversize: !!d.deciding.oversize } : null,
    outcome: outcomeOf(event, d, delivered),
    ...(posted !== undefined ? { posted } : {}),
    tooLarge: hits.some((h) => h.oversize),
    guidance: {
      always,
      skipped: g.skipped.map((s) => ({ ...s })),
      delivered: delivered.map((o) => ({ slug: o.slug, name: o.name, via })),
      indexed: g.onMatch.filter((o) => !deliveredSlugs.has(o.slug)).map((o) => ({ slug: o.slug, name: o.name })),
      proseChars: g.proseChars,
      proseMax: opts.proseMax,
    },
    draft,
  };
}
