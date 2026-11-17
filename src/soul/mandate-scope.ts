/**
 * Scoped mandates: the agent has one global mandate, and a sub-mandate can
 * override, extend or reduce it inside one boundary. Every consumer of "the
 * mandate here" (the turn's system prompt, heartbeat and wake prompts, voice,
 * the console) reads it through {@link resolveMandate}, so they cannot disagree.
 *
 * Boundaries, most specific first: one channel (`channel:<id>`), a channel
 * class from the soul's allow lists (`trust:trusted`, `trust:public`), direct
 * messages (`dm`). Only the single most specific match applies; sub-mandates
 * never stack.
 *
 * Pure: no I/O, types only from the soul schema.
 */
import type { MandateMode, SoulData } from "./data";

export type MandateTrust = "public" | "trusted";
export type MandateBoundary = `channel:${string}` | `trust:${MandateTrust}` | "dm";

export interface SubMandate {
  boundary: MandateBoundary;
  mode: MandateMode;
  text: string;
}

/** Where a mandate is being read. */
export interface MandateContext {
  channelId?: string | null;
  /** The channel's class in the soul's lists, when it is in one. */
  trust?: MandateTrust | null;
  dm?: boolean;
}

/** An extend or reduce, kept in two parts so nothing has to re-parse the rendered text. */
export interface MandateParts {
  global: string;
  /** The labelled addition or limit. */
  addition: string;
}

export interface ResolvedMandate {
  /** The effective mandate text. With nothing applied: `global`, as given. */
  text: string;
  /** The sub-mandate that shaped it; null when the global mandate stands. */
  applied: SubMandate | null;
  /** Present for extend and reduce, where `text` is these two parts joined. */
  parts?: MandateParts;
}

/** Longest mandate line in a bounded prompt. A longer addition or limit is carried whole, and validate-soul warns. */
export const MANDATE_LINE_MAX = 600;

const EXTEND_LABEL = "Additional mandate for";
const REDUCE_LABEL = "Limit for";

function boundaryPhrase(b: MandateBoundary): string {
  if (b === "dm") return "direct messages";
  if (b === "trust:public") return "public channels";
  if (b === "trust:trusted") return "trusted channels";
  return "this channel";
}

function render(global: string, sub: SubMandate): { text: string; parts: MandateParts } {
  const place = boundaryPhrase(sub.boundary);
  const addition =
    sub.mode === "reduce"
      ? `${REDUCE_LABEL} ${place} (this narrows the mandate above and wins over it wherever they conflict):\n${sub.text}`
      : `${EXTEND_LABEL} ${place} (in addition to the mandate above):\n${sub.text}`;
  const head = global.trim();
  return { text: [head, addition].filter(Boolean).join("\n\n"), parts: { global: head, addition } };
}

export function resolveMandate(global: string, subMandates: readonly SubMandate[], context: MandateContext): ResolvedMandate {
  const usable = (boundary: MandateBoundary) => subMandates.find((s) => s.boundary === boundary && s.text.trim());
  const found =
    (context.channelId ? usable(`channel:${context.channelId}`) : undefined) ??
    (context.trust ? usable(`trust:${context.trust}`) : undefined) ??
    (context.dm ? usable("dm") : undefined);
  if (!found) return { text: global, applied: null };
  const applied: SubMandate = { ...found, text: found.text.trim() };
  if (applied.mode === "override") return { text: applied.text, applied };
  return { ...render(global, applied), applied };
}

type SoulMandates = Pick<SoulData, "channelOverrides"> & Partial<Pick<SoulData, "scopeMandates">>;

/** A soul's sub-mandates, each with its mode (`override` when none is written). */
export function subMandatesOf(soul: SoulMandates): SubMandate[] {
  const out: SubMandate[] = [];
  for (const c of soul.channelOverrides) {
    if (c.mandate?.trim()) out.push({ boundary: `channel:${c.channel}`, mode: c.mandateMode ?? "override", text: c.mandate.trim() });
  }
  for (const s of soul.scopeMandates ?? []) {
    if (!s.mandate.trim()) continue;
    out.push({ boundary: s.scope === "dm" ? "dm" : `trust:${s.scope}`, mode: s.mode ?? "override", text: s.mandate.trim() });
  }
  return out;
}

/** The lists that decide a channel's class. */
export type ChannelClasses = Pick<SoulData, "trustedChannels" | "allowedChannels">;

/**
 * Lists from a bundle, or undefined when the field is not an object whose two
 * members are arrays. Non-string entries are dropped. A malformed field reads
 * as absent, never as a throw or a substring match.
 */
export function normalizeChannelClasses(raw: unknown): ChannelClasses | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { trustedChannels, allowedChannels } = raw as Record<string, unknown>;
  if (!Array.isArray(trustedChannels) || !Array.isArray(allowedChannels)) return undefined;
  const strings = (a: unknown[]) => a.filter((x): x is string => typeof x === "string");
  return { trustedChannels: strings(trustedChannels), allowedChannels: strings(allowedChannels) };
}

/** Where `channelId` sits for a soul's lists: the same classes the rest of the runtime reads. */
export function mandateContext(classes: ChannelClasses, channelId: string | null | undefined): MandateContext {
  if (!channelId) return {};
  const has = (list: unknown) => Array.isArray(list) && list.includes(channelId);
  const trust = has(classes?.trustedChannels) ? "trusted" : has(classes?.allowedChannels) ? "public" : null;
  return { channelId, trust, dm: channelId.startsWith("D") };
}

/**
 * The mandate a soul gives one channel. `classes` is the soul whose channel
 * lists decide the class when they are not this soul's own (a named persona
 * inherits the default's lists, see `withAclFallback`).
 */
export function resolveSoulMandate(soul: SoulMandates & Pick<SoulData, "mandate">, channelId: string | null | undefined, classes: ChannelClasses): ResolvedMandate {
  return resolveMandate(soul.mandate ?? "", subMandatesOf(soul), mandateContext(classes, channelId));
}

/**
 * An extend or reduce on one line for a bounded prompt. Only the global part is
 * cut, at `max`; the addition or limit is always carried whole.
 */
export function mandatePartsLine(parts: MandateParts, max: number, flatten: (s: string) => string): string {
  const head = flatten(parts.global);
  return [head.length > max ? `${head.slice(0, max)}…` : head, flatten(parts.addition)].filter(Boolean).join(" ");
}

export interface ModeLine {
  mode: MandateMode;
  /** The value as written, when it was not a known mode (the mode is then `extend`). */
  unknown?: string;
}

/**
 * A `Mode:` line, else null. Bullets, bold and a trailing `#` comment are
 * allowed. The value is one word, so a sentence that starts "Mode:" stays
 * mandate text. An unknown word reads as `extend`: a typo must keep the global
 * mandate, never replace it.
 */
export function parseModeLine(line: string): ModeLine | null {
  const clean = line.replaceAll("*", "").replace(/^\s*-\s+/, "").replace(/\s+#.*$/, "").trim();
  const m = /^mode\s*:\s*(\S*)$/i.exec(clean);
  if (!m) return null;
  const value = m[1]!.toLowerCase();
  return value === "override" || value === "extend" || value === "reduce" ? { mode: value } : { mode: "extend", unknown: m[1]! };
}

/** Whether a soul text uses the scoped-mandate syntax (which extractions made before it cannot have read). */
export function usesScopedMandates(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((l) => SCOPE_HEADING.test(l.trim()) || parseModeLine(l) !== null);
}

const SCOPE_HEADING = /^##\s+scope\s+(dm|public|trusted)\s*$/i;

/**
 * The soul text with its `## Scope dm|public|trusted` blocks removed, for the
 * persona block of a prompt: a scope is delivered only through the resolved
 * mandate, so a turn never reads the scope of a place it is not in. A block
 * ends at the next `#` or `##` heading. Text with no such block is unchanged.
 */
export function stripScopeBlocks(text: string): string {
  const out: string[] = [];
  let skipping = false;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,2}\s/.test(line)) skipping = SCOPE_HEADING.test(line.trim());
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

