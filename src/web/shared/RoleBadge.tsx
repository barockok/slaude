import { Badge, type BadgeTone } from "../ui";

/** A person's role on an agent, as both apps name and color it. */
export type AgentRoleName = "manager" | "approver" | "member";

export const ROLE_LABEL: Record<AgentRoleName, string> = { manager: "Manager", approver: "Approver", member: "Member" };
export const ROLE_TONE: Record<AgentRoleName, BadgeTone> = { manager: "accent", approver: "success", member: "neutral" };

export function RoleBadge({ role }: { role: AgentRoleName }) {
  return <Badge tone={ROLE_TONE[role]}>{ROLE_LABEL[role]}</Badge>;
}
