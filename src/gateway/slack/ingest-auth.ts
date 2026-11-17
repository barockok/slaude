import { roleInternal } from "../../access/authority";
import { deriveSoulGrants } from "../../access/grants";
import { checkAt } from "../../access/wired";
import type { SoulData } from "../../soul/data";
import { channelApproversOf } from "../../soul/per-persona";
import type { SeamCtx } from "./model-auth";

/**
 * Authorisation gate for the /ingest command (Task 10).
 *
 * Returns true when `userId` matches one of:
 *   - the primary manager (`soulData.manager.userId`)
 *   - the backup manager (`soulData.backupManager.userId`)
 *   - any entry in the approvers list (`soulData.approvers[].userId`)
 *
 * All fields are optional in the SoulData schema (`.partial().default({})`),
 * so the function is defensive against missing data.
 */
export async function canTriggerIngest(userId: string, soul: SoulData, seam: SeamCtx = {}): Promise<boolean> {
  const legacy =
    soul.manager?.userId === userId || soul.backupManager?.userId === userId || !!soul.approvers?.some((a) => a.userId === userId);
  // Slice C task 15: shadowed against the engine over the soul's grants; the answer is the one above.
  return checkAt({
    site: "ingest_auth.can_trigger",
    persona: seam.persona,
    teamId: seam.teamId,
    userId,
    legacy,
    grants: () => deriveSoulGrants(soul, channelApproversOf(soul)),
    internal: ({ grants, actor, opts }) => {
      const r = roleInternal(grants, actor, undefined, opts);
      return r === "manager" || r === "approver";
    },
  });
}
