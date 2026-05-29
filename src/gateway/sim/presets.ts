import type { SoulFixture } from "./soul-fixture";

const WORLD: SoulFixture = { manager: "U0MGR", backup: "U0BACKUP", approvers: ["U0APP"], trusted: ["C0TEAM"], allowed: ["C0PUB"] };

export interface ScenarioPreset {
  name: string; title: string; soul: SoulFixture;
  actor: string; channel: string; dm?: boolean; behavior: string;
}

export const PRESETS: ScenarioPreset[] = [
  { name: "manager-dm",         title: "Manager in a DM (restricted zone)",          soul: WORLD, actor: "U0MGR",   channel: "D0MGR",    dm: true,  behavior: "reply" },
  { name: "member-public",      title: "Anyone in an allowed/public channel",        soul: WORLD, actor: "U0ALICE", channel: "C0PUB",              behavior: "reply" },
  { name: "member-trusted",     title: "Anyone in a trusted channel",                soul: WORLD, actor: "U0ALICE", channel: "C0TEAM",             behavior: "reply" },
  { name: "restricted-blocked", title: "Non-manager in an unlisted channel (drop)",  soul: WORLD, actor: "U0BOB",   channel: "C0RANDOM",           behavior: "reply" },
  { name: "approval-flow",      title: "Approval card -> approver authz -> resolve", soul: WORLD, actor: "U0ALICE", channel: "C0TEAM",             behavior: "request_approval" },
  { name: "borrow-grant",       title: "Borrow another user's connection (grant)",   soul: WORLD, actor: "U0BOB",   channel: "C0TEAM",             behavior: "connect_borrow" },
];

export function getPreset(nameOrIndex: string): ScenarioPreset | undefined {
  const byName = PRESETS.find((p) => p.name === nameOrIndex);
  if (byName) return byName;
  const idx = Number(nameOrIndex);
  if (Number.isInteger(idx) && idx >= 1 && idx <= PRESETS.length) return PRESETS[idx - 1];
  return undefined;
}
