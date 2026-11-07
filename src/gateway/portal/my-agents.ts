/**
 * The agents a person holds a role on, for the portal's My agents page.
 *
 * User-level roles only: a role that comes from a grant naming the person's
 * Slack user (soul-derived or stored in the console). Admission through a
 * channel or workspace grant is left out, because it says where the agent
 * answers, not that this person holds anything on it. Deny still wins, and
 * channel-scoped approvers count only where roleOf would count them without a
 * channel (the global ones), so this agrees with roleOf on user grants.
 */
import type { Grant } from "../../access/grants";
import { loadGrants, roleFromGrants } from "../../access/role";
import { getPersonaRegistry } from "../../persona/registry";
import type { MyAgentView } from "./api-types";

export async function myAgents(identities: ReadonlyArray<{ teamId: string; slackUserId: string }>): Promise<MyAgentView[]> {
  if (identities.length === 0) return [];
  const r = getPersonaRegistry();
  const personas = ["default", ...r.list().map((p) => p.name).filter((n) => n !== "default").sort()];
  const grants = new Map<string, Grant[]>();
  await Promise.all(
    personas.map(async (p) => {
      try {
        grants.set(p, (await loadGrants(p)).filter((g) => g.subjectKind === "user"));
      } catch (e) {
        console.error(`[portal] my-agents: grants for persona=${p} unreadable, skipped: ${e instanceof Error ? e.name : typeof e}`);
      }
    }),
  );
  const out: MyAgentView[] = [];
  for (const id of identities) {
    for (const persona of personas) {
      const userGrants = grants.get(persona);
      if (!userGrants) continue;
      const role = roleFromGrants(userGrants, id.slackUserId);
      if (role) out.push({ persona, teamId: id.teamId, slackUserId: id.slackUserId, role });
    }
  }
  return out;
}
