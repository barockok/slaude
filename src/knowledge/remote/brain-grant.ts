/**
 * Where `slaude brain connect` keeps the remote brain's grant. The brain token
 * is an agent-owned MCP credential, so it follows the same rule as /mcp connect:
 * on a gateway it goes to the credential store (the brain client reads it from
 * there, and a file on the shared volume would be read by nothing); in mono it
 * goes to the agent's config directory as before.
 */
import { env } from "../../config/env";
import { agentConfigDir } from "../../agent/oauth-home";
import { oauthKey, toStoredEntry, writeEntry, type OAuthServerConfig, type OAuthTokens } from "../../agent/mcp-oauth/store";
import { putCredential } from "../../db/mcp-credentials";

export const BRAIN_SERVER_NAME = "slaude_brain";

export async function persistBrainGrant(url: string, tokens: OAuthTokens): Promise<"store" | "disk"> {
  const cfg: OAuthServerConfig = { type: "http", url };
  if (env.role() === "gateway") {
    await putCredential(
      { kind: "agent", tenant: "default", persona: "default" },
      oauthKey(BRAIN_SERVER_NAME, cfg),
      toStoredEntry(BRAIN_SERVER_NAME, cfg, tokens),
    );
    return "store";
  }
  writeEntry(agentConfigDir(), BRAIN_SERVER_NAME, cfg, tokens);
  return "disk";
}
