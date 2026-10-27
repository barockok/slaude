/**
 * `proactive_rule` (spec §5 "Changing a rule"): a person tells the agent how
 * to handle a kind of item from now on, and the agent records it as a rule
 * page in its own slice. The checks live here, not in the prompt:
 *   - never in a /1on1 (a private thread must not shape posts to others);
 *   - lowering a rule for this channel or DM applies at once;
 *   - raising is capped by the SOUL's `Highest` for the scope, and within it
 *     needs an approver for the scope (the speaker, or one who approves the
 *     card the turn opens);
 *   - `global` always needs the manager or backup, in either direction.
 * `taughtBy` is the turn's signed sender (ctx.userId), never an argument.
 * Shared by the in-process MCP server (createRuntimeMcp) and the node relay
 * (POST /v1/tools/runtime/proactive_rule).
 */
import { backgroundAgentId } from "../background/skill-check";
import * as OneOnOne from "../db/one-on-one";
import { isManagerOrApprover, type SlackContext } from "../gateway/slack/mcp-tools";
import { brainCall } from "../knowledge/brain";
import { SUPERSEDED_TAG, supersededSlugs, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId, type BrainScope } from "../knowledge/scope";
import { effectiveSoulForChannel, soulData } from "../soul/extract";
import { proactiveFor } from "../soul/proactive";
import { levelRank, type Level } from "./levels";
import { composeRulePage, loadRules, resolveLevel } from "./rules";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export const ONE_ON_ONE_REFUSAL = "refused: teach this outside the /1on1, so it can apply to others";

export interface ProactiveRuleArgs {
  kind: string;
  scope: "here" | "global";
  level: Level;
  how?: string;
  quote: string;
}

let callOverride: BrainOpCall | null = null;

/** Test seam: the brain call the relay path uses (null restores brainCall). */
export function __setRuleBrainCall(call: BrainOpCall | null): void {
  callOverride = call;
}

const mention = (id: string) => `<@${id}>`;

/** Manager and backup (global and DM rules). */
function managers(): string[] {
  const s = soulData();
  return [s.manager?.userId, s.backupManager?.userId].filter((u): u is string => !!u);
}

/** Who may approve a rule for this scope, as Slack mentions. */
function approverNames(channel: string | null): string {
  const ids = new Set(managers());
  if (channel) for (const a of effectiveSoulForChannel(channel).approvers ?? []) ids.add(a.userId);
  return ids.size > 0 ? [...ids].map(mention).join(", ") : "the manager";
}

export async function proactiveRule(
  ctx: SlackContext,
  a: ProactiveRuleArgs,
  deps: { call?: BrainOpCall; now?: () => Date } = {},
): Promise<ToolResult> {
  const userId = ctx.userId;
  if (!userId) return err(ONE_ON_ONE_REFUSAL);
  if (ctx.channel && ctx.threadTs && (await OneOnOne.find(ctx.channel, ctx.threadTs))) return err(ONE_ON_ONE_REFUSAL);

  const dm = ctx.channel.startsWith("D");
  const scope = a.scope === "global" ? "global" : dm ? userId : ctx.channel;
  // The channel whose approvers and ceiling apply; null for global and DMs.
  const channel = a.scope === "here" && !dm ? ctx.channel : null;
  const where = scope === "global" ? "everywhere" : channel ? `in <#${channel}>` : `in DMs with ${mention(userId)}`;
  const how = a.how?.trim() || undefined;
  if (a.level === "act" && !how) return err("refused: `act` needs `how`: say what you will do each time");

  const call = deps.call ?? callOverride ?? brainCall;
  const now = (deps.now ?? (() => new Date()))();
  const persona = ctx.personaId ?? "default";
  const agentId = await backgroundAgentId(persona);
  const composed = composeRulePage({
    kind: a.kind, scope, level: a.level, how: how ?? null,
    taughtBy: userId, taughtAt: now.toISOString(), thread: `${ctx.channel}/${ctx.threadTs}`,
    quote: a.quote,
  }, now);
  if ("error" in composed) return err(composed.error);

  let current: Level;
  try {
    const rules = await loadRules(agentId, call);
    current = resolveLevel({ rules, kind: a.kind, destination: scope, proposed: "act", highest: "act" }).level;
  } catch (e) {
    return err(`could not read the current rules: ${e instanceof Error ? e.message : String(e)}`);
  }

  const raising = levelRank(a.level) > levelRank(current);
  if (raising) {
    const highest = proactiveFor(persona, channel ?? undefined).highest;
    if (levelRank(a.level) > levelRank(highest)) {
      return err(`refused: the SOUL caps ${where} at \`${highest}\`, so \`${a.level}\` is out of reach. Only the SOUL can raise that ceiling.`);
    }
  }

  // Lowering here applies at once; raising, or any global rule, needs an approver for the scope.
  const canApprove = (u: string) => (channel ? isManagerOrApprover(u, channel) : managers().includes(u));
  let approvedBy: string | undefined;
  if ((raising || scope === "global") && !canApprove(userId)) {
    const who = approverNames(channel);
    if (!ctx.requestApproval) return err(`refused: this needs approval from ${who}, and no approval card can be opened here`);
    const r = await ctx.requestApproval({
      summary: `Let me handle ${a.kind} at ${a.level} ${where}${how ? `: ${how}` : ""}`,
      category: "proactive-rule",
    });
    if (!r.approved) return err(`not approved${r.by ? ` by ${mention(r.by)}` : ""}${r.note ? `: ${r.note}` : ""}; the rule was not changed`);
    // The card's clickers come from the channel's approver list (or anyone,
    // when it has none), so check the clicker against this scope too.
    if (!canApprove(r.by)) return err(`refused: ${mention(r.by)} cannot approve this; it needs ${who}`);
    approvedBy = r.by;
  }

  const source = agentSourceId(agentId);
  const brainScope: BrainScope = { clientId: agentId, sourceId: source, allowedSources: [source] };
  try {
    // The page of the same slug is the earlier rule for this kind and scope:
    // put_page replaces it, and a superseded tag it carried is dropped so
    // loadRules sees the new rule.
    const tagged = await supersededSlugs(call, brainScope, [source]);
    await call("put_page", { slug: composed.slug, content: composed.content }, brainScope);
    if (tagged.has(composed.slug)) await call("remove_tag", { slug: composed.slug, tag: SUPERSEDED_TAG }, brainScope);
  } catch (e) {
    return err(`the rule was not saved: ${e instanceof Error ? e.message : String(e)}`);
  }
  return ok(`saved: ${a.kind} ${where} is now \`${a.level}\` (was \`${current}\`)${approvedBy ? `, approved by ${mention(approvedBy)}` : ""}`);
}
