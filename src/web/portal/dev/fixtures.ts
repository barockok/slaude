/**
 * Portal fixtures with generic placeholder names, for the dev stub
 * (VITE_STUB=1). Plain data, no DOM. Times are relative to `now` so
 * "in 3 h" stays true.
 */
import type { IntegrationView, MyAgentView, PortalMeResponse } from "../../../gateway/portal/api-types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface PortalFixtures {
  me: PortalMeResponse;
  integrations: IntegrationView[];
  agents: MyAgentView[];
}

export function createFixtures(now: number = Date.now()): PortalFixtures {
  return {
    me: {
      email: "jane.doe@example.com",
      accountId: "acct_01",
      issuer: "https://idp.example.com/realms/team",
      slackIdentities: [
        { surface: "slack", teamId: "TWORKSPACE", slackUserId: "UALICE", linkedAt: now - 41 * DAY, linkedVia: "signed-link", teamName: "Example Workspace", userName: "Alice" },
        { surface: "slack", teamId: "TSANDBOX", slackUserId: "UJANEDOE", linkedAt: now - 3 * DAY, linkedVia: "signed-link" },
      ],
    },
    integrations: [
      {
        id: "issue-tracker", name: "issue-tracker", host: "mcp.issue-tracker.example.com",
        connected: true, expiresAt: now + 3 * HOUR, usedBy: ["default", "triage"],
      },
      {
        id: "docs-wiki", name: "docs-wiki", host: "wiki.example.com",
        connected: false, expiresAt: null, usedBy: ["default", "scout"], plugin: "example-toolkit",
      },
      {
        id: "ci-status", name: "ci-status", host: "ci.example.com",
        connected: true, expiresAt: now - 2 * DAY, usedBy: ["triage"],
      },
    ],
    agents: [
      { persona: "default", surface: "slack", teamId: "TWORKSPACE", slackUserId: "UALICE", teamName: "Example Workspace", userName: "Alice", role: "manager" },
      { persona: "scout", surface: "slack", teamId: "TWORKSPACE", slackUserId: "UALICE", teamName: "Example Workspace", userName: "Alice", role: "approver" },
      { persona: "triage", surface: "slack", teamId: "TWORKSPACE", slackUserId: "UALICE", teamName: "Example Workspace", userName: "Alice", role: "member" },
      { persona: "scout", surface: "slack", teamId: "TSANDBOX", slackUserId: "UJANEDOE", role: "member" },
    ],
  };
}
