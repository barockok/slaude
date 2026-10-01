/**
 * The nudge that sends someone to the portal, posted when they open a 1:1 and
 * their Slack identity is not bound to an account yet.
 *
 * Onboarding unlocks a person's own integrations; it never gates the agent. So
 * this is a message and nothing else: whatever it returns, the 1:1 is already
 * open and works.
 *
 * Ephemeral or not at all. An onboarding link binds whoever redeems it to their
 * own account, so posting one where the channel can see it hands a bystander the
 * chance to bind the wrong Slack identity — the same reason /link refuses to
 * fall back to a public post.
 */
import { env } from "../../config/env";
import { accountForSlackUser } from "../../db/accounts";
import { mintLinkToken } from "./link-token";

export type NudgeOutcome = "posted" | "already-linked" | "portal-disabled" | "no-private-surface";

export interface NudgeDeps {
  /** Absent when the surface cannot post privately. */
  sayEphemeral?: (text: string) => Promise<void>;
  enabled?: () => boolean;
  accountFor?: (teamId: string, slackUserId: string) => Promise<unknown | null>;
  publicUrl?: () => string;
  mint?: (who: { teamId: string; slackUserId: string }) => string;
}

export async function nudgeOnboarding(
  who: { teamId: string; slackUserId: string },
  deps: NudgeDeps,
): Promise<NudgeOutcome> {
  const enabled = deps.enabled ?? (() => env.portal.enabled());
  // Nowhere to send them, so nothing to say. A link to a portal that 404s is
  // worse than silence.
  if (!enabled()) return "portal-disabled";

  const accountFor = deps.accountFor ?? accountForSlackUser;
  if (await accountFor(who.teamId, who.slackUserId)) return "already-linked";

  if (!deps.sayEphemeral) return "no-private-surface";

  const publicUrl = (deps.publicUrl ?? (() => env.panel.publicUrl()))();
  const token = (deps.mint ?? mintLinkToken)(who);
  await deps.sayEphemeral(
    `:link: Connect your account to use your own integrations here: ${publicUrl}/portal/link?t=${token}\n` +
      `Only you can see this message. The link expires in 15 minutes.`,
  );
  return "posted";
}
