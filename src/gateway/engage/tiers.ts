/**
 * The deterministic engagement tiers (0 to 2), and the shape of tier 3's
 * candidates. A pure function of normalised message facts: no clock, no
 * database, no Slack call, no model. The first rule that settles a message
 * wins; the order below is the plan's table (docs/plans/2026-11-17-thread-head-
 * and-natural-routing.md, "The tiers").
 *
 * Name and alias matching strips quotes, fenced and inline code, links and
 * emails first, and is whole-word, case-folded and NFKC-normalised. Text that
 * was forwarded or shared sits in attachments, not in `text`, and the caller
 * never passes it here, so it is never matched.
 */
import { foldAlias } from "../../persona/aliases";
import type { LastSpeaker } from "./last-speaker";

export type TierLevel = "mention" | "addressed" | "contribute";
export type TierAction = "pass" | "run" | "classify" | "existing";

export interface TierResult {
  tier: 0 | 1 | 2 | 3;
  action: TierAction;
  reason: string;
  /** Tier 3 root-question band only: how long the caller waits for a human answer before asking. */
  debounceMs?: number;
}

export interface TierFacts {
  text: string;
  /** Slack message subtype; absent or empty for a plain message. */
  subtype?: string | null;
  authorIsBot: boolean;
  authorId: string;
  /** Slack user ids that are this agent (its bot user, its persona user). */
  selfUserIds: ReadonlySet<string>;
  hasFiles: boolean;
  /** A reply inside a thread (thread_ts differs from ts). */
  isThreadReply: boolean;
  /** A top-level channel message (or a thread opener). */
  isRoot: boolean;
  /** The thread already has an engaged session for this agent. */
  threadEngaged: boolean;
  level: TierLevel;
  restricted: boolean;
  locks: { oneOnOne: boolean; mentionOnly: boolean; disengaged: boolean };
  lastSpeaker: LastSpeaker | null;
  agent: { name: string; aliases: readonly string[]; app?: string };
  /** Names of the other registered agents (compared folded). */
  otherAgents: ReadonlySet<string>;
  /** Whether a human in the channel goes by this folded name (the users cache; no Slack call). */
  sameNamedHuman: (foldedName: string) => boolean;
  nowMs: number;
  windowMs: number;
  /** Two or more humans took turns since the agent last spoke. */
  humansAlternated: boolean;
  /** Contribute-only root band inputs (the caller owns timers). */
  rootBand?: { minLength: number; debounceMs: number };
}

export const ALLOWED_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "me_message", "thread_broadcast"]);

/** Ack phrases, folded. A message made only of these (and punctuation, emoji) needs no reply. */
export const ACK_PHRASES: readonly string[] = [
  "ok", "okay", "okey", "oke", "k", "kk", "alright", "all right", "sure", "cool", "nice", "great", "perfect", "awesome", "excellent", "good", "fine",
  "thanks", "thank you", "thx", "ty", "tysm", "thanks a lot", "thanks so much", "thank you so much", "thanks again", "many thanks", "cheers",
  "got it", "gotcha", "noted", "understood", "makes sense", "sounds good", "sounds great", "will do", "roger", "ack", "np", "no problem",
  "that worked", "that works", "it worked", "it works", "works for me", "works now", "that did it", "fixed", "done", "resolved",
  "lgtm", "+1", "yes", "yep", "yup", "yeah", "no", "nope", "agreed", "right", "true", "exactly", "indeed",
  "so much", "a lot", "again", "all", "everyone", "man", "bro", "mate", "folks", "guys", "team", "now", "too", "also", "much appreciated", "appreciated",
];

/** Words that begin a sentence and are followed by a comma without naming anyone. */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  "hi", "hello", "hey", "yes", "no", "ok", "okay", "so", "well", "also", "however", "thanks", "thank", "sorry", "please", "btw", "fyi", "now", "then",
  "first", "second", "finally", "actually", "basically", "anyway", "meanwhile", "otherwise", "still", "yet", "and", "but", "or", "if", "when", "while",
  "since", "because", "though", "although", "maybe", "perhaps", "sure", "right", "good", "great", "nice", "cool", "wow", "oh", "ah", "hmm", "update",
  "reminder", "note", "heads", "morning", "afternoon", "evening", "everyone", "everybody", "all", "team", "folks", "guys", "today", "tomorrow", "yesterday",
]);

const REQUEST_STARTS: ReadonlySet<string> = new Set([
  "please", "pls", "can", "could", "would", "will", "should", "do", "does", "did", "is", "are", "was", "were", "have", "has", "what", "why", "how",
  "when", "where", "who", "which", "check", "look", "take", "fix", "add", "run", "send", "show", "tell", "explain", "find", "make", "create", "update",
  "write", "help", "review", "summarize", "summarise", "list", "open", "try", "give", "get", "let", "draft", "build", "remove", "delete", "move",
  "post", "share", "compare", "calculate", "convert", "translate", "search", "investigate", "debug", "deploy", "test", "plan", "set", "change",
]);

const SECOND_PERSON = /\b(you|your|yours|you're|youre|you'll|you've|u|ya|y'all)\b/i;

/** Fenced and inline code, then quote lines. */
function stripCodeAndQuotes(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((l) => !/^\s*(>|&gt;)/.test(l))
    .join("\n");
}

/** Links, channel links and emails. User, group and broadcast tokens are kept. */
function stripLinks(text: string): string {
  return text
    .replace(/<(https?:|mailto:|tel:|#C)[^>]*>/gi, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, " ");
}

/** The text the rules read: code, quotes, links and emails gone, NFKC. */
export function cleanText(text: string): string {
  return stripLinks(stripCodeAndQuotes(text.normalize("NFKC")));
}

const MENTION_TOKEN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const GROUP_OR_BROADCAST = /<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>|<!(?:here|channel|everyone)(?:\|[^>]*)?>|(?<![\w@])@(?:here|channel|everyone)\b/i;

/** Remove mention tokens and Slack's other angle tokens so a bare `<!date>` or similar is not text. */
const plain = (s: string): string => s.replace(MENTION_TOKEN, " ").replace(/<![^>]*>/g, " ").replace(/<[^>]*>/g, " ");

/** Whether the text is only ack phrases, punctuation, shortcodes and emoji. */
export function isAckOnly(text: string): boolean {
  let s = plain(text).toLowerCase();
  s = s.replace(/:[a-z0-9_+-]+:/g, " ").replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, " ");
  s = s.replace(/[^\p{L}\p{N}+\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (!s) return true;
  const phrases = [...ACK_PHRASES].sort((a, b) => b.length - a.length);
  let guard = 0;
  while (s && guard++ < 20) {
    const hit = phrases.find((p) => s === p || s.startsWith(`${p} `));
    if (!hit) return false;
    s = s.slice(hit.length).trim();
  }
  return !s;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (f: TierFacts): string[] => [f.agent.name, ...f.agent.aliases].map(foldAlias).filter(Boolean);
const NAME_EDGE = String.raw`(?<![\p{L}\p{N}_])`;
const NAME_END = String.raw`(?![\p{L}\p{N}_])`;

/** The name or alias (folded) the text begins with, followed by `sep`; null when none. */
function leadingName(text: string, ns: string[], sep: "," | ":" | "any"): { name: string; rest: string } | null {
  const folded = text.toLowerCase();
  for (const n of ns) {
    const tail = sep === "any" ? "" : String.raw`\s*${esc(sep)}`;
    const m = new RegExp(String.raw`^\s*@?${esc(n)}${NAME_END}${tail}`, "u").exec(folded);
    if (m) return { name: n, rest: text.slice(m[0].length).trim() };
  }
  return null;
}

/** Whether any name appears as a whole word anywhere. */
function namesAnywhere(text: string, ns: string[]): boolean {
  const folded = text.toLowerCase();
  return ns.some((n) => new RegExp(`${NAME_EDGE}@?${esc(n)}${NAME_END}`, "u").test(folded));
}

/** Second-person or imperative shape: a question mark, "you", or a request verb or question word first. */
export function hasRequestShape(text: string): boolean {
  const s = plain(text).trim();
  if (!s) return false;
  if (s.includes("?") || SECOND_PERSON.test(s)) return true;
  const first = /^[^\p{L}\p{N}]*([\p{L}']+)/u.exec(s.toLowerCase())?.[1];
  return !!first && REQUEST_STARTS.has(first);
}

/** A plain vocative at the start ("Budi, can you ..."): the capitalised word, or an @word, before a comma. */
function vocative(raw: string): string | null {
  const m = /^\s*(@)?(\p{Lu}[\p{L}\p{N}'.-]{1,31}|[\p{L}][\p{L}\p{N}'.-]{1,31})\s*,\s*\S/u.exec(raw);
  if (!m) return null;
  const word = m[2]!;
  if (!m[1] && !/^\p{Lu}/u.test(word)) return null;
  const folded = foldAlias(word);
  return NOT_A_NAME.has(folded) ? null : folded;
}

const pass = (tier: 0 | 2, reason: string): TierResult => ({ tier, action: "pass", reason });

function followsOtherAgent(f: TierFacts): boolean {
  const s = f.lastSpeaker;
  if (!s) return false;
  const own = foldAlias(f.agent.name);
  const sp = foldAlias(s.persona);
  if (sp !== own && f.otherAgents.has(sp)) return true;
  return !!s.app && !!f.agent.app && s.app !== f.agent.app;
}

/** Run the ladder. Total: it never throws for any input. */
export function runTiers(f: TierFacts): TierResult {
  if (f.level === "mention") return pass(0, "level_mention");
  if (f.restricted) return pass(0, "restricted");
  if (f.subtype && !ALLOWED_SUBTYPES.has(f.subtype)) return pass(0, "subtype");
  if (f.authorIsBot) return pass(0, "bot_author");
  if (f.locks.oneOnOne) return pass(0, "lock_1on1");

  const raw = stripCodeAndQuotes((f.text ?? "").normalize("NFKC"));
  const mentioned = [...raw.matchAll(MENTION_TOKEN)].map((m) => m[1]!);
  if (mentioned.some((u) => f.selfUserIds.has(u))) return { tier: 1, action: "run", reason: "mention" };

  if (mentioned.length) return pass(0, "names_other_person");
  if (GROUP_OR_BROADCAST.test(raw)) return pass(0, "names_group");
  const text = stripLinks(raw);
  const ns = names(f);
  const voc = vocative(text);
  if (voc && !ns.includes(voc)) return pass(0, f.otherAgents.has(voc) ? "names_other_agent" : "vocative_other");

  if (f.locks.mentionOnly) return pass(0, "lock_mention_only");
  if (f.locks.disengaged) return pass(0, "lock_disengaged");
  if (!f.hasFiles && isAckOnly(text)) return pass(0, "ack");
  if (followsOtherAgent(f)) return pass(0, "follows_other_agent");

  if (f.threadEngaged) return { tier: 1, action: "existing", reason: "engaged_thread" };

  const comma = leadingName(text, ns, ",");
  if (comma) {
    if (f.sameNamedHuman(comma.name)) return { tier: 3, action: "classify", reason: "same_named_human" };
    if (hasRequestShape(comma.rest)) return { tier: 1, action: "run", reason: "name_comma" };
    return { tier: 3, action: "classify", reason: "name_no_request_shape" };
  }
  const nameUsed = namesAnywhere(text, ns);
  if (nameUsed) return { tier: 3, action: "classify", reason: leadingName(text, ns, ":") ? "name_colon" : "name_mid" };

  const s = f.lastSpeaker;
  if (s && foldAlias(s.persona) === foldAlias(f.agent.name)) {
    const sentAt = Number.parseFloat(s.ts) * 1000;
    const within = Number.isFinite(sentAt) && f.nowMs - sentAt <= f.windowMs && f.nowMs >= sentAt - 60_000;
    if (within) {
      if (f.humansAlternated) return pass(2, "humans_alternating");
      if (s.repliedToUser && s.repliedToUser === f.authorId && (hasRequestShape(text) || f.hasFiles)) return { tier: 2, action: "run", reason: "follows_agent" };
      return { tier: 3, action: "classify", reason: "follower_failed_test" };
    }
  }

  if (f.level === "contribute" && f.rootBand && f.isRoot && !f.isThreadReply) {
    const long = [...plain(text).trim()].length >= f.rootBand.minLength;
    const asks = plain(text).includes("?") || hasRequestShape(text);
    if (long && asks) return { tier: 3, action: "classify", reason: "root_question", debounceMs: f.rootBand.debounceMs };
  }
  return pass(0, "no_band");
}
