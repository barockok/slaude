/**
 * Replies under a proactive post (spec §5 Stitching): a reply's turn starts
 * knowing what the agent posted and why. The `<proactive-context>` block has
 * the dispatched act/ask envelope's shape and escaping (dispatch.ts `safe`,
 * the same lines), without its `<runtime-check>`: a reply is a person
 * talking, not a check. Only threaded replies count (owner's decision): the
 * caller passes the reply's thread root, and a top-level message is its own
 * root, which is never a post.
 */
import * as Posts from "../db/proactive-posts";
import { brainCallIfOpen } from "../knowledge/brain";
import { proactiveFor } from "../soul/proactive";
import { ruleLine, safe, sourceLine } from "./dispatch";
import { loadRules, type ProactiveRule } from "./rules";

export interface ReplyContextDeps {
  /** Default: Posts.findByMessage. */
  find?: typeof Posts.findByMessage;
  /** The agent's live rules. Default: loadRules over an already-open brain only (brainCallIfOpen). */
  rules?: (agentId: string) => Promise<ProactiveRule[]>;
}

/**
 * The block for a reply in `threadTs`, or "" when the thread root is not a
 * proactive post. The rule is loaded only when the post named one; a rule
 * since superseded is named as no longer in force. The ceiling is the
 * persona's `Highest` for the post's place (its channel, else global). A
 * failure throws: the caller treats it as no block.
 */
export async function proactiveReplyBlock(
  m: { channel: string; threadTs: string; personaId?: string },
  deps: ReplyContextDeps = {},
): Promise<string> {
  const post = await (deps.find ?? Posts.findByMessage)(m.channel, m.threadTs);
  if (!post) return "";
  const c = post.context;
  const posted = new Date(post.postedAt).toISOString();
  const lines = [
    "<proactive-context>",
    safe(post.text)
      ? `You posted this proactively (${posted}) about "${safe(post.topic)}": ${safe(post.text)}`
      : `You posted this proactively (${posted}) about "${safe(post.topic)}". Its text was not kept.`,
  ];
  if (c) {
    lines.push(sourceLine(c));
    if (c.ruleSlug) {
      const rules = await (deps.rules ?? ((agentId: string) => loadRules(agentId, brainCallIfOpen)))(post.agentId);
      const rule = rules.find((r) => r.slug === c.ruleSlug);
      lines.push(rule ? ruleLine(rule) : `Rule: ${safe(c.ruleSlug)} (no longer in force).`);
    } else {
      lines.push(ruleLine(null));
    }
  }
  const highest = proactiveFor(m.personaId ?? "default", post.audience === "channel" ? post.recipient : undefined).highest;
  lines.push(
    `Most allowed here: ${safe(highest)}.`,
    "A reply here may change how you handle this kind of item: use proactive_rule.",
    "</proactive-context>",
  );
  return lines.join("\n");
}
