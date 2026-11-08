/**
 * Effective guardrails (design sections 1b, 2 and 4): which stored guardrails
 * apply to an agent in a channel, and what a session built from them carries.
 *
 * Pure: the input is a list of documents (GUARDRAIL.md text plus where it came
 * from), already verified by the caller (src/guardrails/snapshot.ts on the
 * gateway; a node trusts the bundle its gateway verified and signed into the
 * ETag). The same functions run in a mono process, on the gateway and on a
 * node, so all three apply the same rules.
 */
import { parseGuardrail, type GuardrailRule, type ParsedGuardrail } from "./format";
import type { Pattern } from "./pattern";
import type { RuleHit } from "./match";

/** One stored guardrail as the runtime reads it. */
export interface GuardrailDoc {
  slug: string;
  /** The effective text: a console override's when one exists, else the source row's. */
  md: string;
  source: "file" | "git" | "console";
  /** The text is a console override (phase B writes them). */
  override: boolean;
  /** The override was written against an older source text. */
  behindSource: boolean;
  /** The console kill switch. */
  enabled: boolean;
}

export interface ResolvedGuardrail extends ParsedGuardrail {
  doc: GuardrailDoc;
}

export function resolveDocs(docs: readonly GuardrailDoc[]): ResolvedGuardrail[] {
  return docs.map((doc) => ({ ...parseGuardrail(doc.slug, doc.md), doc }));
}

/** On and readable: the kill switch and the frontmatter's own `enabled`. */
export function isActive(g: ResolvedGuardrail): boolean {
  return g.doc.enabled && !!g.meta && g.meta.enabled;
}

/** Whether `g` applies to `agent` at all (any channel). `shared` includes the default agent. */
export function appliesToAgent(g: ResolvedGuardrail, agent: string): boolean {
  if (!isActive(g)) return false;
  return g.meta!.scope === "shared" || g.meta!.agents.includes(agent);
}

/**
 * Whether `g` applies to `agent` in `channel`. A guardrail limited to channels
 * applies only where the session has one of them; a session with no channel
 * (a background pass) gets only the guardrails that are not limited.
 */
export function appliesTo(g: ResolvedGuardrail, agent: string, channel: string | null | undefined): boolean {
  if (!appliesToAgent(g, agent)) return false;
  const ch = g.meta!.channels;
  return ch.length === 0 || (!!channel && ch.includes(channel));
}

/** The documents that apply to `agent` in some channel (what a node's bundle carries). */
export function docsForAgent(resolved: readonly ResolvedGuardrail[], agent: string): GuardrailDoc[] {
  return resolved.filter((g) => appliesToAgent(g, agent)).map((g) => g.doc);
}

/** Enforced rules a node must apply for this agent (decides the capability check). */
export function hasEnforcedRules(resolved: readonly ResolvedGuardrail[], agent: string): boolean {
  return resolved.some((g) => appliesToAgent(g, agent) && g.rules.some((r) => r.status === "enforced"));
}

export interface OnMatchGuidance {
  slug: string;
  name: string;
  description: string;
  body: string;
  tool: Pattern[];
  inbound?: Pattern;
  /** Limit the trigger to these channels (empty = wherever the guardrail applies). */
  channels: string[];
}

export interface SkippedProse {
  slug: string;
  name: string;
  chars: number;
}

export interface SessionGuardrails {
  /** The guardrail set version this was built from. */
  version: number;
  /** Enforced tool rules, in guardrail then rule order. */
  toolRules: RuleHit[];
  /** Enforced inbound rules (the gateway checks them before a turn). */
  inboundRules: RuleHit[];
  /** Enforced reply rules (the gateway's outbound choke point checks them). */
  replyRules: RuleHit[];
  /** `<owner-guardrails>` for the system prompt, or null when nothing applies. */
  promptBlock: string | null;
  /** On-match Guidance, delivered once per session when a trigger matches. */
  onMatch: OnMatchGuidance[];
  /** Always-loaded prose left out because it did not fit the cap. */
  skipped: SkippedProse[];
  /** Characters of always-loaded prose that made it in. */
  proseChars: number;
}

export const EMPTY_SESSION_GUARDRAILS: SessionGuardrails = Object.freeze({
  version: 0, toolRules: [], inboundRules: [], replyRules: [], promptBlock: null, onMatch: [], skipped: [], proseChars: 0,
}) as SessionGuardrails;

const tagSafe = (s: string) => s.replace(/<(\/?)owner-guardrails?\b/gi, "&lt;$1owner-guardrail");

/**
 * What a session of `agent` in `channel` carries. Always-loaded prose is
 * taken in slug order while it fits `proseMax` characters; a guardrail that
 * would tip the total over is left out (named in `skipped`) and the next ones
 * are still tried.
 */
export function sessionGuardrails(
  resolved: readonly ResolvedGuardrail[],
  agent: string,
  channel: string | null | undefined,
  opts: { version: number; proseMax: number },
): SessionGuardrails {
  const applied = resolved.filter((g) => appliesTo(g, agent, channel)).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const hits = (on: GuardrailRule["on"]): RuleHit[] =>
    applied.flatMap((g) => g.rules.filter((r) => r.on === on && r.status === "enforced").map((rule) => ({ slug: g.slug, rule })));
  const always: ResolvedGuardrail[] = [];
  const skipped: SkippedProse[] = [];
  const onMatch: OnMatchGuidance[] = [];
  let proseChars = 0;
  for (const g of applied) {
    const m = g.meta!;
    if (!g.prose) continue;
    if (m.load === "on-match") {
      onMatch.push({ slug: g.slug, name: m.name, description: m.description, body: g.prose, tool: m.triggers.tool, ...(m.triggers.inbound ? { inbound: m.triggers.inbound } : {}), channels: m.triggers.channels });
      continue;
    }
    if (proseChars + g.prose.length > opts.proseMax) {
      skipped.push({ slug: g.slug, name: m.name, chars: g.prose.length });
      continue;
    }
    proseChars += g.prose.length;
    always.push(g);
  }
  let promptBlock: string | null = null;
  if (always.length || onMatch.length) {
    const parts = [
      "<owner-guardrails>",
      "The owner of this deployment set these guardrails for you. Follow them. Some actions are also checked by code: when a tool call or message is refused with a guardrail's message, accept it and do not try to get around it.",
    ];
    for (const g of always) parts.push("", `## ${g.meta!.name}`, tagSafe(g.prose));
    if (onMatch.length) {
      parts.push("", "Guardrails you are given when they become relevant (you will receive the full text then):");
      for (const o of onMatch) parts.push(`- ${o.name}: ${tagSafe(o.description || "(no description)")}`);
    }
    parts.push("</owner-guardrails>");
    promptBlock = parts.join("\n");
  }
  return { version: opts.version, toolRules: hits("tool"), inboundRules: hits("inbound"), replyRules: hits("reply"), promptBlock, onMatch, skipped, proseChars };
}

/** On-match guidance whose tool trigger matches `toolName` in `channel`. */
export function toolTriggered(s: SessionGuardrails, toolName: string, channel: string | null | undefined): OnMatchGuidance[] {
  return s.onMatch.filter((o) => o.tool.some((p) => p.test(toolName)) && (o.channels.length === 0 || (!!channel && o.channels.includes(channel))));
}

/** On-match guidance whose inbound trigger matches `text` in `channel`. */
export function inboundTriggered(s: SessionGuardrails, text: string, channel: string | null | undefined): OnMatchGuidance[] {
  return s.onMatch.filter((o) => !!o.inbound && o.inbound.test(text) && (o.channels.length === 0 || (!!channel && o.channels.includes(channel))));
}

/** The text a once-per-session delivery hands the model. */
export function guidanceText(items: ReadonlyArray<Pick<OnMatchGuidance, "name" | "body">>): string {
  return items.map((o) => `<owner-guardrail name="${o.name}">\n${tagSafe(o.body)}\n</owner-guardrail>`).join("\n");
}
