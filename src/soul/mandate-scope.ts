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

export interface ResolvedMandate {
  /** The effective mandate text. With nothing applied: `global`, as given. */
  text: string;
  /** The sub-mandate that shaped it; null when the global mandate stands. */
  applied: SubMandate | null;
}

const EXTEND_LABEL = "Additional mandate for";
const REDUCE_LABEL = "Limit for";

function boundaryPhrase(b: MandateBoundary): string {
  if (b === "dm") return "direct messages";
  if (b === "trust:public") return "public channels";
  if (b === "trust:trusted") return "trusted channels";
  return "this channel";
}

function render(global: string, sub: SubMandate): string {
  const place = boundaryPhrase(sub.boundary);
  const addition =
    sub.mode === "reduce"
      ? `${REDUCE_LABEL} ${place} (this narrows the mandate above and wins over it wherever they conflict):\n${sub.text}`
      : `${EXTEND_LABEL} ${place} (in addition to the mandate above):\n${sub.text}`;
  return [global.trim(), addition].filter(Boolean).join("\n\n");
}

export function resolveMandate(global: string, subMandates: readonly SubMandate[], context: MandateContext): ResolvedMandate {
  const usable = (boundary: MandateBoundary) => subMandates.find((s) => s.boundary === boundary && s.text.trim());
  const found =
    (context.channelId ? usable(`channel:${context.channelId}`) : undefined) ??
    (context.trust ? usable(`trust:${context.trust}`) : undefined) ??
    (context.dm ? usable("dm") : undefined);
  if (!found) return { text: global, applied: null };
  const applied: SubMandate = { ...found, text: found.text.trim() };
  return { text: applied.mode === "override" ? applied.text : render(global, applied), applied };
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

/** Where `channelId` sits for a soul's lists: the same classes the rest of the runtime reads. */
export function mandateContext(classes: ChannelClasses, channelId: string | null | undefined): MandateContext {
  if (!channelId) return {};
  const trust = classes.trustedChannels.includes(channelId) ? "trusted" : classes.allowedChannels.includes(channelId) ? "public" : null;
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
 * Cut an effective mandate to `max` characters without losing its sub-mandate:
 * when the text carries a rendered addition or limit, the global part before
 * it is what gets cut. Plain text is cut at the end, as any line would be.
 * Whitespace is collapsed onto one line by the caller's `flatten`.
 */
export function clipEffectiveMandate(text: string, max: number, flatten: (s: string) => string): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const at = Math.max(text.lastIndexOf(`\n\n${REDUCE_LABEL} `), text.lastIndexOf(`\n\n${EXTEND_LABEL} `));
  if (at < 0) return cut(flatten(text), max);
  const head = flatten(text.slice(0, at));
  const tail = flatten(text.slice(at));
  if (head.length + 1 + tail.length <= max) return `${head} ${tail}`;
  if (tail.length >= max) return cut(tail, max);
  const room = max - tail.length - 2;
  return room > 0 ? `${head.slice(0, room)}… ${tail}` : tail;
}

const MODE_VALUE = "(override|extend|reduce)";

/** The `Mode:` value on a line, else null. Bullets, bold and a trailing `#` comment are allowed. */
export function modeLineValue(line: string): MandateMode | null {
  const clean = line.replaceAll("*", "").replace(/^\s*-\s+/, "").replace(/\s+#.*$/, "").trim();
  const m = new RegExp(`^mode\\s*:\\s*${MODE_VALUE}$`, "i").exec(clean);
  return m ? (m[1]!.toLowerCase() as MandateMode) : null;
}

/** Whether a soul text uses the scoped-mandate syntax (which extractions made before it cannot have read). */
export function usesScopedMandates(text: string): boolean {
  return /^##\s+scope\s+(dm|public|trusted)\s*$/im.test(text) || new RegExp(`^\\s*(?:[-*]\\s+)?\\**mode\\**\\s*:\\**\\s*${MODE_VALUE}\\b`, "im").test(text);
}
