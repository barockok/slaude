/**
 * Rule matching and combining (design sections 1 and 3).
 *
 * Tool input is matched per field (a dot path into the input, each pattern on
 * that field's string values) or with one pattern on every string value of
 * the input. Never on the serialised JSON: a pattern meant for one field must
 * not match a key name, a quote or another field's text. Values are walked
 * with depth, count and size bounds. Padding cannot hide a value: an input
 * or text past any bound is too large to check, and that counts as a match for
 * deny and approve rules (fail closed with a "too large to check" message);
 * audit rules stay best effort.
 *
 * All applicable rules are evaluated. Per event the strictest action decides
 * (deny > approve > redact > audit); every rule that matched is returned, so
 * each can be audited, and the message shown is the deciding rule's.
 */
import type { GuardrailRule, RuleAction, RuleOn } from "./format";
import { capText, MAX_MATCH_CHARS } from "./pattern";

/** Bounds of the walk over a tool input. Past any of them the input is too large to check. */
export const MAX_DEPTH = 32;
export const MAX_LEAVES = 10_000;
export const MAX_TOTAL_CHARS = 4 * 1024 * 1024;

/** The string values under a value, and whether the walk hit a bound (size, depth, count). */
export interface Leaves {
  values: string[];
  /** Something was left unchecked: a string over the cap, too many values, too deep, too much text. */
  overflow: boolean;
}

/** String leaves under `v` (numbers and booleans as text), bounded. */
export function stringLeaves(v: unknown): Leaves {
  const out: Leaves = { values: [], overflow: false };
  let total = 0;
  const walk = (x: unknown, depth: number): void => {
    if (out.overflow) return;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      if (out.values.length >= MAX_LEAVES) {
        out.overflow = true;
        return;
      }
      const s = String(x);
      total += s.length;
      if (s.length > MAX_MATCH_CHARS || total > MAX_TOTAL_CHARS) {
        out.overflow = true;
        out.values.push(capText(s));
        return;
      }
      out.values.push(s);
      return;
    }
    if (x === null || typeof x !== "object") return;
    if (depth >= MAX_DEPTH) {
      out.overflow = true;
      return;
    }
    for (const y of Array.isArray(x) ? x : Object.values(x as Record<string, unknown>)) walk(y, depth + 1);
  };
  walk(v, 0);
  return out;
}

/** The value at a dot path; a numeric segment indexes an array. */
export function atPath(input: unknown, path: string): unknown {
  let cur: unknown = input;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else {
      if (!Object.hasOwn(cur as object, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/** `oversize`: the rule could not be checked fully because the input or text is too large. */
export type MatchResult = "match" | "no" | "oversize";

function leavesMatch(l: Leaves, test: (s: string) => boolean): MatchResult {
  if (l.values.some(test)) return "match";
  return l.overflow ? "oversize" : "no";
}

/** A tool rule against a call. `names`: the tool's name and any other name it goes by (a remote alias's builtin). */
export function toolRuleMatch(rule: GuardrailRule, names: string | readonly string[], input: unknown): MatchResult {
  const m = rule.tool;
  if (rule.on !== "tool" || !m) return "no";
  const list = typeof names === "string" ? [names] : names;
  if (!m.tool.some((g) => list.some((n) => g.test(n)))) return "no";
  let oversize = false;
  const conds: Array<() => MatchResult> = [];
  if (m.anyValue) conds.push(() => leavesMatch(stringLeaves(input), (s) => m.anyValue!.test(s)));
  for (const f of m.fields ?? []) conds.push(() => leavesMatch(stringLeaves(atPath(input, f.path)), (s) => f.pattern.test(s)));
  for (const c of conds) {
    const r = c();
    if (r === "no") return "no";
    if (r === "oversize") oversize = true;
  }
  return oversize ? "oversize" : "match";
}

/** A reply or inbound rule against a text. */
export function textRuleMatch(rule: GuardrailRule, on: Exclude<RuleOn, "tool">, text: string): MatchResult {
  if (rule.on !== on || !rule.text) return "no";
  if (rule.text.test(text)) return "match";
  return text.length > MAX_MATCH_CHARS ? "oversize" : "no";
}

/**
 * Whether a result counts as a hit for this rule. Too large to check is a
 * hit for deny and approve (fail closed) and not for audit (best effort).
 */
export function counts(rule: GuardrailRule, r: MatchResult): boolean {
  return r === "match" || (r === "oversize" && rule.action !== "audit");
}

export function toolRuleMatches(rule: GuardrailRule, toolName: string | readonly string[], input: unknown): boolean {
  return counts(rule, toolRuleMatch(rule, toolName, input));
}

export function textRuleMatches(rule: GuardrailRule, on: Exclude<RuleOn, "tool">, text: string): boolean {
  return counts(rule, textRuleMatch(rule, on, text));
}

/** The hits of a set of rules against a tool call, each marked when it counted only because the input was too large. */
export function toolHits(rules: readonly RuleHit[], names: readonly string[], input: unknown): RuleHit[] {
  const out: RuleHit[] = [];
  for (const h of rules) {
    const r = toolRuleMatch(h.rule, names, input);
    if (counts(h.rule, r)) out.push(r === "oversize" ? { ...h, oversize: true } : h);
  }
  return out;
}

/** The hits of a set of text rules against a text, marked like toolHits. */
export function textHits(rules: readonly RuleHit[], on: Exclude<RuleOn, "tool">, text: string): RuleHit[] {
  const out: RuleHit[] = [];
  for (const h of rules) {
    const r = textRuleMatch(h.rule, on, text);
    if (counts(h.rule, r)) out.push(r === "oversize" ? { ...h, oversize: true } : h);
  }
  return out;
}

/** The message a deciding hit shows. */
export function hitMessage(h: RuleHit): string {
  if (h.oversize) return `This is too large for the owner's guardrail ${h.slug} to check, so it is refused.`;
  return h.rule.message.trim() || `Blocked by the owner's guardrail ${h.slug}.`;
}

const RANK: Record<RuleAction, number> = { deny: 4, approve: 3, redact: 2, audit: 1 };

/** A rule that matched, with the guardrail it belongs to. */
export interface RuleHit {
  slug: string;
  rule: GuardrailRule;
  /** Counted because the input or text was too large to check (fail closed). */
  oversize?: true;
}

export interface Decision {
  /** The strictest action among the hits. */
  action: RuleAction;
  /** The hit whose action decided (the first of the strictest, in order). */
  deciding: RuleHit;
  /** Every hit, each audited. */
  hits: RuleHit[];
}

/** The strictest of the hits, or null when none matched. */
export function combine(hits: RuleHit[]): Decision | null {
  if (hits.length === 0) return null;
  let deciding = hits[0]!;
  for (const h of hits) if (RANK[h.rule.action] > RANK[deciding.rule.action]) deciding = h;
  return { action: deciding.rule.action, deciding, hits };
}
