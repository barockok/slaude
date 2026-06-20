#!/usr/bin/env bun
// `slaude brain connect` — one-time OAuth bootstrap for the remote brain MCP server.
//
// Drives the existing shared-loopback authorization_code flow against the brain
// server's advertised authorization server (Keycloak first), then persists the
// grant under the `slaude_brain` key in the agent's credential store. The refresh
// token sustains the link after this; re-run only if the grant is revoked.

import { randomBytes } from "node:crypto";
import { discover } from "../agent/mcp-oauth/discovery";
import { beginConnectShared } from "../agent/mcp-oauth/shared-client";
import { writeEntry, type OAuthServerConfig } from "../agent/mcp-oauth/store";
import { agentConfigDir } from "../agent/oauth-home";
import { brainRemoteUrl } from "../knowledge/brain-config";

const BRAIN_SERVER_NAME = "slaude_brain";

async function main(): Promise<void> {
  let url: string;
  try {
    url = brainRemoteUrl();
  } catch {
    console.error("Set SLAUDE_BRAIN_URL (the remote brain MCP server URL) before connecting.");
    process.exit(1);
    return;
  }

  console.log(`[brain connect] discovering authorization server for ${url} …`);
  const meta = await discover(url);

  const serverConfig: OAuthServerConfig = { type: "http", url };
  const stateSecret = process.env.SLAUDE_OAUTH_STATE_SECRET || randomBytes(32).toString("hex");
  const handle = await beginConnectShared({
    meta,
    serverConfig,
    sessionId: "brain-connect",
    stateSecret,
  });

  console.log("\nOpen this URL in a browser to authorize slaude → brain:\n");
  console.log("  " + handle.authorizeUrl + "\n");
  console.log("[brain connect] waiting for the OAuth callback …");

  const code = await handle.waitForCode();
  const tokens = await handle.exchange(code);
  writeEntry(agentConfigDir(), BRAIN_SERVER_NAME, serverConfig, tokens);

  console.log(`\n[brain connect] connected — credentials stored for ${BRAIN_SERVER_NAME}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[brain connect] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
