/**
 * Feedback on proactive posts (spec §10.5). A reply in a proactive post's
 * thread, or a reaction to it, is recorded as an `outcome`; a reply that says
 * "stop" or "not this" mutes that post's topic in the replier's own profile,
 * for that topic only (one dismissal is never a full opt-out).
 *
 * Who counts: for a DM (manager, person) only the person it was addressed to;
 * for a channel post any human in the channel, and a mute goes to the
 * replier's own profile. The mute is written from the replier's own words
 * (their reply is the quote, invariant 2); a reaction never mutes.
 *
 * Outcomes record only the signal (replied, reacted, muted), never what was
 * said: a DM outcome goes to that person's own slice (a DM is theirs), a
 * channel outcome to the agent's slice.
 */
import { composePage, readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId, speakerProfileSource, userSourceId, type BrainScope } from "../knowledge/scope";
import * as Posts from "../db/proactive-posts";
import type { ProactivePost } from "../db/proactive-posts";
import { prefsFromProfile } from "./prefs";

const COMMON = new Set(["type", "as_of", "confidence", "source", "subject", "supersedes", "superseded_by"]);

/**
 * True when a reply is only a request to stop (mentions and punctuation
 * aside): "stop", "not this", "mute", "no more", with at most a "please",
 * "thanks", "pinging me", "this one", "of these". A message that goes on to
 * say something else ("stop the rollout, the numbers are wrong") is not one:
 * it reaches the agent as usual.
 */
export function stopPhrase(text: string): boolean {
  const t = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .toLowerCase()
    .replace(/[.!,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(please )?(stop|not this|mute|no more)( (please|thanks|thank you|pinging me|this|this one|one|of these|these|it))*$/.test(t);
}

export interface FeedbackDeps {
  call: BrainOpCall;
  now: () => Date;
  /** Post one line in the thread, as the agent. */
  reply(channel: string, threadTs: string, text: string): Promise<void>;
  /** Claim an event once (Slack retries; on a multi-app gateway each app gets a copy). Default: always first. */
  once?: (key: string) => Promise<boolean>;
}

const only = (clientId: string, source: string): BrainScope => ({ clientId, sourceId: source, allowedSources: [source] });

/** May this user's feedback count for this post? */
const counts = (post: ProactivePost, userId: string): boolean => post.audience === "channel" || post.recipient === userId;

async function writeOutcome(post: ProactivePost, userId: string, signal: string, deps: FeedbackDeps): Promise<void> {
  const source = post.audience === "channel" ? agentSourceId(post.agentId) : userSourceId(userId);
  const client = post.audience === "channel" ? post.agentId : userId;
  const page = composePage(
    {
      slug: `outcomes/proactive-${post.id}`,
      content: `A proactive post about "${post.topic}" got this signal: ${signal}.`,
      type: "outcome",
      subject: userId,
      source: `${post.channelId}:${post.messageTs ?? ""}`,
      fields: { action: "proactive-post", topic: post.topic, signal },
    },
    deps.now(),
  );
  if ("error" in page) throw new Error(page.error);
  await deps.call("put_page", { slug: `outcomes/proactive-${post.id}`, content: page.content }, only(client, source));
}

/** Add `topic` to the user's profile mutes, keeping everything else on the page. */
async function muteTopic(post: ProactivePost, userId: string, teamId: string | null, quote: string, deps: FeedbackDeps): Promise<boolean> {
  const source = speakerProfileSource(teamId ?? post.teamId, userId);
  if (source === null) return false;
  const scope = only(userId, source);
  const rec = readPageRecord(await getPageOrNull(deps.call, "profile", scope));
  const meta = rec && !rec.superseded ? rec.meta : {};
  const prefs = prefsFromProfile(meta);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (!COMMON.has(k) && !/[\r\n]/.test(v)) fields[k] = v;
  if (prefs.mutes !== "all" && !prefs.mutes.includes(post.topic)) fields.mutes = [...prefs.mutes, post.topic].join(", ");
  fields.quote = quote.replace(/\s+/g, " ").trim().slice(0, 500);
  const page = composePage(
    { slug: "profile", content: rec?.body ?? "", type: "profile", subject: userId, source: `told by ${userId}`, fields },
    deps.now(),
  );
  if ("error" in page) throw new Error(page.error);
  await deps.call("put_page", { slug: "profile", content: page.content }, scope);
  return true;
}

/**
 * A reply in some thread. "ignored" when the thread is not a proactive post
 * (or the replier's feedback does not count): normal handling continues.
 * "muted": the topic is muted and the agent said so; normal handling stops.
 */
export async function onProactiveReply(
  i: { channel: string; threadTs: string; ts: string; userId: string; teamId: string | null; text: string },
  deps: FeedbackDeps,
): Promise<"muted" | "outcome" | "ignored"> {
  const post = await Posts.findByMessage(i.channel, i.threadTs);
  if (!post || !counts(post, i.userId)) return "ignored";
  // A second copy of the same reply (a retry, another app's delivery): already handled.
  if (deps.once && !(await deps.once(`proactive-fb:${i.channel}:${i.ts}`))) return stopPhrase(i.text) ? "muted" : "ignored";
  if (stopPhrase(i.text)) {
    if (await muteTopic(post, i.userId, i.teamId, i.text, deps)) {
      await writeOutcome(post, i.userId, "asked to stop", deps);
      await deps.reply(i.channel, i.threadTs, `Got it, I'll stop pinging you about ${post.topic}.`);
      return "muted";
    }
  }
  await writeOutcome(post, i.userId, "replied", deps);
  return "outcome";
}

/** A reaction to some message: an outcome when it is a proactive post. Never a mute. */
export async function onProactiveReaction(
  i: { channel: string; messageTs: string; userId: string; reaction: string },
  deps: FeedbackDeps,
): Promise<"outcome" | "ignored"> {
  const post = await Posts.findByMessage(i.channel, i.messageTs);
  if (!post || !counts(post, i.userId)) return "ignored";
  if (deps.once && !(await deps.once(`proactive-fb:${i.channel}:${i.messageTs}:${i.userId}:${i.reaction}`))) return "ignored";
  await writeOutcome(post, i.userId, `reacted :${i.reaction.replace(/[^a-z0-9_+-]/gi, "")}:`, deps);
  return "outcome";
}
