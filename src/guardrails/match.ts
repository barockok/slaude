/**
 * Rule matching and combining (design sections 1 and 3).
 *
 * Tool input is matched per field (a dot path into the input, each pattern on
 * that field's string values) or with one pattern on every string value of
 * the input. Never on the serialised JSON: a pattern meant for one field must
 * not match a key name, a quote or another field's text. Values are walked
 * with depth, count and size bounds, so a huge `Write` body costs at most the
 * match budget.
 *
 * All applicable rules are evaluated. Per event the strictest action decides
 * (deny > approve > redact > audit); every rule that matched is returned, so
 * each can be audited, and the message shown is the deciding rule's.
 */
import type { GuardrailRule, RuleAction, RuleOn } from "./format";
import { capText } from "./pattern";

const MAX_DEPTH = 8;
const MAX_LEAVES = 200;

/** String leaves under `v` (numbers and booleans as text), bounded. */
export function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_LEAVES || depth > MAX_DEPTH) return out;
  if (typeof v === "string") out.push(capText(v));
  else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) stringLeaves(x, out, depth + 1);
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

export function toolRuleMatches(rule: GuardrailRule, toolName: string, input: unknown): boolean {
  const m = rule.tool;
  if (rule.on !== "tool" || !m) return false;
  if (!m.tool.some((g) => g.test(toolName))) return false;
  if (m.anyValue && !stringLeaves(input).some((s) => m.anyValue!.test(s))) return false;
  if (m.fields) {
    for (const f of m.fields) {
      if (!stringLeaves(atPath(input, f.path)).some((s) => f.pattern.test(s))) return false;
    }
  }
  return true;
}

export function textRuleMatches(rule: GuardrailRule, on: Exclude<RuleOn, "tool">, text: string): boolean {
  return rule.on === on && !!rule.text && rule.text.test(text);
}

const RANK: Record<RuleAction, number> = { deny: 4, approve: 3, redact: 2, audit: 1 };

/** A rule that matched, with the guardrail it belongs to. */
export interface RuleHit {
  slug: string;
  rule: GuardrailRule;
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
