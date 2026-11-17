/**
 * The classifier's view of one implicit candidate: a GateInput built only when
 * a classifier is actually going to be asked (tier 3, or a sampled tier 2), so
 * no message that never reaches it costs a history call.
 *
 * What leaves the gateway is chosen here:
 *  - the agent's own name, aliases, display name and every mention of its
 *    identities become `<agent>`, in the message and in `recent`;
 *  - `recent` keeps only what the ingress would have let in: an author the
 *    persona does not admit, an ignored author and text the owner's inbound
 *    deny rules refuse are dropped (one reusable author filter), and a third
 *    party bot's text (CI output, other integrations) is never sent unless
 *    ALLOW_THIRD_PARTY_BOT_TEXT is changed in code;
 *  - every line is neutralised like the thread head is (no `<` survives except
 *    the tokens this module writes), whitespace is flattened and each line cut;
 *  - at most one Slack read: the thread's last messages for a threaded
 *    candidate (one replies call), the channel's last messages for a root (one
 *    history call), under one deadline. A failed or late read rejects, and the
 *    caller reads that as a pass.
 * There is no knowledge-base search, so no document score leaves with it.
 */
import { foldAlias } from "../../persona/aliases";
import { redactSecrets } from "../../redact";
import { normalizeSlackText } from "../gate/context";
import type { GateInput, ImplicitLevel, Trust } from "../gate/types";
import type { AuthorFilter } from "../core/author-filter";
import { plainPiece, type ThreadMsg } from "../core/thread-head";

/** Whether another bot's text may be sent to the classifier. Documented as never; changing it is a code and docs change. */
export const ALLOW_THIRD_PARTY_BOT_TEXT = false;
/** Characters of one line sent. */
export const LINE_CHARS = 400;
/** Most recent messages sent when the gate config asks for more. */
export const MAX_RECENT = 12;
export const DEFAULT_DEADLINE_MS = 2000;

export interface InputDeps {
  /** The thread's last `limit` messages up to and including the event (oldest first). One call. */
  replies: (threadTs: string, limit: number) => Promise<ThreadMsg[]>;
  /** The channel's last `limit` top-level messages before the event (oldest first). One call. */
  history: (limit: number) => Promise<ThreadMsg[]>;
  filter: AuthorFilter;
  /**
   * A per-message refusal the author filter cannot know: a thread-level ignore
   * for the message's own thread (each message of a channel history is its own
   * thread). True drops the message.
   */
  dropMessage?: (m: ThreadMsg) => Promise<boolean>;
  /** One of this persona's own identities. */
  isSelf: (m: ThreadMsg) => boolean;
  /** Slack user ids that are this agent (bot user, persona user). */
  selfUserIds: ReadonlySet<string>;
  /** The identity the message is addressed to (the delivering bot). */
  botUserId: string;
  /** The agent's name, aliases and display names, as written. */
  names: readonly string[];
  channelTrust: Trust;
  contextMessages?: number;
  deadlineMs?: number;
  allowThirdPartyBotText?: boolean;
}

export interface ImplicitRequest {
  ts: string;
  text: string;
  /** The thread the message is in; null for a root message. */
  threadTs: string | null;
  level: ImplicitLevel;
  continuation: boolean;
}

export interface BuiltInput {
  input: GateInput;
  /** Two or more humans took turns since the agent last spoke; false whenever no thread was read. */
  alternated: boolean;
  /** Which single Slack read was made. */
  read: "replies" | "history";
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKENS = /<(agent|user|channel|group|here|email|phone|link)>/g;
/** A token written by a person is text, not one of ours: it is defanged before any of ours is written. */
const FORGED_TOKEN = /<(agent|user|channel|group|here|email|phone|link)>/gi;
const TOKEN_LIST = ["agent", "user", "channel", "group", "here", "email", "phone", "link"];
const PRIVATE = /[\uE000\uE001]/g;
const WORD = /@?[\p{L}\p{N}_]+/gu;

/**
 * One line as sent: secrets masked, Slack markup reduced, the agent's names
 * (folded exactly as the ladder folds them: NFKC, lower case, whole word)
 * rewritten, neutralised, flattened and cut. A literal `<agent>` or `<user>`
 * in the text does not survive as a token.
 */
export function sendableLine(raw: string, d: Pick<InputDeps, "selfUserIds" | "botUserId" | "names">, max = LINE_CHARS): string {
  let s = raw.replace(PRIVATE, "").replace(FORGED_TOKEN, "\u2039$1\u203a");
  for (const id of d.selfUserIds) if (id) s = s.replace(new RegExp(`<@${escapeRe(id)}(?:\\|[^>]*)?>`, "g"), "<agent>");
  s = normalizeSlackText(s, d.botUserId);
  // The tokens this module (and normalizeSlackText) writes survive neutralisation as private-use placeholders.
  s = s.replace(TOKENS, (_m, t: string) => `\uE000${TOKEN_LIST.indexOf(t)}\uE001`);
  s = redactSecrets(plainPiece(s));
  const names = [...new Set(d.names.map(foldAlias).filter((n) => n.length >= 2))];
  if (names.length) {
    const words = new Set(names.filter((n) => /^[\p{L}\p{N}_]+$/u.test(n)));
    s = s.replace(WORD, (w) => (words.has(foldAlias(w.replace(/^@/, ""))) ? "\uE0000\uE001" : w));
    // A name with punctuation in it ("my-agent") is matched as a whole phrase, whole word at both ends.
    const phrases = names.filter((n) => !words.has(n)).sort((a, b) => b.length - a.length);
    if (phrases.length) s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}_])@?(?:${phrases.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "giu"), "\uE0000\uE001");
  }
  if (s.length > max) s = s.slice(0, max).replace(/[\ud800-\udbff]$/, "").replace(/\uE000\d?$/, "") + "...";
  return s.replace(/\uE000(\d)\uE001/g, (_m, i: string) => `<${TOKEN_LIST[Number(i)]}>`).replace(PRIVATE, "");
}

const isBotMessage = (m: ThreadMsg): boolean => Boolean(m.bot_id) || m.subtype === "bot_message";

class DeadlineError extends Error {}

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new DeadlineError("deadline")), ms); })]).finally(() => clearTimeout(timer));
}

/** Humans who spoke after the agent's last message (the event's author included) and whether at least two differ. */
function humansTookTurns(msgs: ThreadMsg[], d: InputDeps, eventAuthor: string | undefined): boolean {
  let after = msgs;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (d.isSelf(msgs[i]!)) {
      after = msgs.slice(i + 1);
      break;
    }
  }
  const who = new Set(after.filter((m) => m.user && !isBotMessage(m) && !d.isSelf(m)).map((m) => m.user!));
  if (eventAuthor) who.add(eventAuthor);
  return who.size >= 2;
}

export async function buildImplicitInput(d: InputDeps, r: ImplicitRequest, eventAuthor?: string): Promise<BuiltInput> {
  const limit = Math.max(1, Math.min(d.contextMessages ?? 8, MAX_RECENT));
  const deadline = d.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const threaded = r.threadTs !== null && r.threadTs !== r.ts;
  const fetched = await bounded(threaded ? d.replies(r.threadTs!, limit + 1) : d.history(limit), deadline);
  const earlier = fetched.filter((m) => Number(m.ts) < Number(r.ts)).slice(-limit);

  const recent: GateInput["recent"] = [];
  const allowBots = d.allowThirdPartyBotText ?? ALLOW_THIRD_PARTY_BOT_TEXT;
  const checks = await bounded(
    Promise.all(
      earlier.map(async (m) => {
        // Someone the ingress cannot place (no user and no bot) is not admitted by default.
        if (!m.user && !m.bot_id) return false;
        const self = d.isSelf(m);
        if (!self && isBotMessage(m) && !allowBots) return false;
        if (!(await d.filter.allows(m))) return false;
        return !(d.dropMessage && (await d.dropMessage(m)));
      }),
    ),
    deadline,
  );
  earlier.forEach((m, i) => {
    if (!checks[i]) return;
    const text = sendableLine((m.text ?? "").toString(), d);
    if (text) recent.push({ role: d.isSelf(m) ? "agent" : "user", text });
  });

  return {
    input: {
      message: sendableLine(r.text, d, 1000),
      recent,
      // The message is not an @mention (that is tier 1) and the thread is not an engaged one.
      mentionsAgent: false,
      engaged: false,
      kbHitScore: null,
      channelTrust: d.channelTrust,
      implicit: r.level,
      continuation: r.continuation,
    },
    alternated: threaded ? humansTookTurns(earlier, d, eventAuthor) : false,
    read: threaded ? "replies" : "history",
  };
}
