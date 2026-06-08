import type { SoulData } from "../../soul/data";

/** The engagement layers the agent treats differently — pick one to set the channel/DM the
 *  message arrives on. (Maps to the real soul gates: trusted/allowed channels, restricted DM.) */
export type LayerName = "dm" | "trusted" | "allowed" | "restricted";
export interface Layer { name: LayerName; channel: string; dm: boolean; desc: string }

export const LAYERS: Layer[] = [
  { name: "dm",         channel: "D0SIM",    dm: true,  desc: "DM with the bot (restricted zone — manager only)" },
  { name: "trusted",    channel: "C0TEAM",   dm: false, desc: "a trusted channel" },
  { name: "allowed",    channel: "C0PUB",    dm: false, desc: "an allowed / public channel" },
  { name: "restricted", channel: "C0RANDOM", dm: false, desc: "an unlisted channel (messages drop)" },
];

export function findLayer(name: string): Layer | undefined {
  return LAYERS.find((l) => l.name === name);
}

/** Roles you can act as during a session. manager/approver/backup come from the active soul;
 *  member/outsider are fixed synthetic users that are NOT on any gate (so they exercise the
 *  trusted-member and unlisted-outsider paths). */
export const ROLE_NAMES = ["manager", "approver", "backup", "member", "outsider"] as const;

export function resolveRole(role: string, soul: Partial<SoulData>): string | undefined {
  switch (role) {
    case "manager": return soul.manager?.userId;
    case "approver": return soul.approvers?.[0]?.userId;
    case "backup": return soul.backupManager?.userId;
    case "member": return "U0ALICE";
    case "outsider": return "U0BOB";
    default: return undefined;
  }
}
