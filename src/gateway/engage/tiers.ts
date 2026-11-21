/**
 * The engagement ladder: safety rules, then the classifier. A pure function of
 * normalised message facts: no clock, no database, no Slack call, no model. A
 * rule may only state a certain fact (the level, a lock, the author is a bot,
 * the text mentions someone by Slack token, another registered agent is named
 * or spoke last); it never guesses at meaning. Everything the rules leave open
 * is a candidate for the classifier.
 *
 * Mention detection strips quotes, fenced and inline code first. Text that was
 * forwarded or shared sits in attachments, not in `text`, and the caller never
 * passes it here, so it is never matched.
 */
import { foldAlias } from "../../persona/aliases";
import type { LastSpeaker } from "./last-speaker";

export type TierLevel = "mention" | "addressed" | "contribute";
export type TierAction = "pass" | "run" | "classify" | "existing";

export interface TierResult {
  tier: 0 | 1 | 3;
  action: TierAction;
  reason: string;
  /** Classify only: this agent spoke last here, within the window (the classifier input's `continuation`). */
  continuation?: boolean;
}

export interface TierFacts {
  text: string;
  /** Slack message subtype; absent or empty for a plain message. */
  subtype?: string | null;
  authorIsBot: boolean;
  /** Slack user ids that are this agent (its bot user, its persona user). */
  selfUserIds: ReadonlySet<string>;
  /** The thread already has an engaged session for this agent. */
  threadEngaged: boolean;
  level: TierLevel;
  restricted: boolean;
  locks: { oneOnOne: boolean; mentionOnly: boolean; disengaged: boolean };
  /** This agent's own record of where it last spoke (read by the caller for a message the rules do not settle first). */
  lastSpeaker: LastSpeaker | null;
  /** The newest record another persona left in this place, read without clearing it. */
  otherSpeaker?: LastSpeaker | null;
  /** `name` is the persona name ('default' for the default persona). */
  agent: { name: string };
  /** Names of the other registered agents (compared folded). */
  otherAgents: ReadonlySet<string>;
  nowMs: number;
  windowMs: number;
}

export const ALLOWED_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "me_message", "thread_broadcast"]);

/** Bound on the text the ladder reads; the caller truncates and counts, the ladder cuts again to be safe. */
export const MAX_TEXT = 4000;

/** Fenced and inline code, then quote lines. */
function stripCodeAndQuotes(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((l) => !/^\s*(>|&gt;)/.test(l))
    .join("\n");
}

const MENTION_TOKEN = /<@([UW][A-Z0-9]{1,32})(?:\|[^>]{0,80})?>/g;
const GROUP_OR_BROADCAST = /<!subteam\^[A-Z0-9]{1,32}(?:\|[^>]{0,80})?>|<!(?:here|channel|everyone)(?:\|[^>]{0,80})?>|(?<![\w@])@(?:here|channel|everyone)\b/i;

/** The text begins with the name of another registered agent and a comma ("Robin, ..."). A known agent, not a guess. */
function namesOtherAgent(text: string, others: ReadonlySet<string>): boolean {
  const m = /^\s*@?([\p{L}\p{N}][\p{L}\p{N}'.-]{0,31})\s*,/u.exec(text);
  return !!m && others.has(foldAlias(m[1]!));
}

const pass = (reason: string): TierResult => ({ tier: 0, action: "pass", reason });

const sentMs = (r: LastSpeaker): number => Number.parseFloat(r.ts) * 1000;
const fresh = (f: TierFacts, r: LastSpeaker): boolean => {
  const at = sentMs(r);
  return Number.isFinite(at) && f.nowMs - at <= f.windowMs && f.nowMs >= at - 60_000;
};

/** This agent's own record, when it is within the window. */
const ownFresh = (f: TierFacts): LastSpeaker | null =>
  f.lastSpeaker && foldAlias(f.lastSpeaker.persona) === foldAlias(f.agent.name) && fresh(f, f.lastSpeaker) ? f.lastSpeaker : null;

/** Another registered agent spoke last here, within the window, and after this agent did. */
function followsOtherAgent(f: TierFacts): boolean {
  const o = f.otherSpeaker;
  if (!o || !fresh(f, o)) return false;
  const own = f.lastSpeaker && fresh(f, f.lastSpeaker) ? f.lastSpeaker : null;
  if (own && sentMs(own) >= sentMs(o)) return false;
  const sp = foldAlias(o.persona);
  return sp !== foldAlias(f.agent.name) && (f.otherAgents.has(sp) || sp === "default");
}

/** Run the ladder. Total: it never throws for any input. */
export function runTiers(input: TierFacts): TierResult {
  const f: TierFacts = input.text && input.text.length > MAX_TEXT ? { ...input, text: input.text.slice(0, MAX_TEXT) } : input;
  if (f.level === "mention") return pass("level_mention");
  if (f.restricted) return pass("restricted");
  if (f.subtype && !ALLOWED_SUBTYPES.has(f.subtype)) return pass("subtype");
  if (f.authorIsBot) return pass("bot_author");
  if (f.locks.oneOnOne) return pass("lock_1on1");

  const raw = stripCodeAndQuotes((f.text ?? "").normalize("NFKC"));
  const mentioned = [...raw.matchAll(MENTION_TOKEN)].map((m) => m[1]!);
  if (mentioned.some((u) => f.selfUserIds.has(u))) return { tier: 1, action: "run", reason: "mention" };

  if (mentioned.length) return pass("names_other_person");
  if (GROUP_OR_BROADCAST.test(raw)) return pass("names_group");
  if (namesOtherAgent(raw, f.otherAgents)) return pass("names_other_agent");

  if (f.locks.mentionOnly) return pass("lock_mention_only");
  if (f.locks.disengaged) return pass("lock_disengaged");
  if (followsOtherAgent(f)) return pass("follows_other_agent");

  if (f.threadEngaged) return { tier: 1, action: "existing", reason: "engaged_thread" };

  return ownFresh(f) ? { tier: 3, action: "classify", reason: "classify", continuation: true } : { tier: 3, action: "classify", reason: "classify" };
}
