import { admitInternal, roleInternal } from "../../access/authority";
import { deriveSoulGrants } from "../../access/grants";
import { checkAt } from "../../access/wired";
import type { SoulData } from "../../soul/data";
import { channelApproversOf } from "../../soul/per-persona";

/** Where the check is made, for the shadow of the internal-id path only. */
export interface SeamCtx {
  persona?: string | null;
  teamId?: string | null;
}

/**
 * Authorisation gate for the /model command: primary manager, backup manager,
 * any approver, or any DM-allowed user (`dmAllowedUsers`).
 *
 * Note: `dmAllowedUsers` does NOT confer manager authority on the other admin
 * commands (cron / ignore / ingest). `/model` intentionally widens the gate to
 * the DM allowlist — per-thread model choice is low-risk and self-scoped.
 * Defensive against missing soul fields (all optional in the schema).
 */
export async function canChangeModel(userId: string, soul: SoulData, seam: SeamCtx = {}): Promise<boolean> {
  const legacy =
    soul.manager?.userId === userId ||
    soul.backupManager?.userId === userId ||
    !!soul.approvers?.some((a) => a.userId === userId) ||
    !!soul.dmAllowedUsers?.includes(userId);
  // Slice C task 15: the same question over the soul's grants and the resolved
  // person. Under shadow the answer returned is the one above; under `internal` it is the engine's.
  return checkAt({
    site: "model_auth.can_change",
    persona: seam.persona,
    teamId: seam.teamId,
    userId,
    legacy,
    grants: () => deriveSoulGrants(soul, channelApproversOf(soul)),
    internal: ({ grants, actor, opts }) => {
      const r = roleInternal(grants, actor, undefined, opts);
      return r === "manager" || r === "approver" || admitInternal({ grants, actor, channelId: "", isDM: true, opts }).ok;
    },
  });
}
