import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/db/schema";
import * as Creds from "../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { oauthKey, readEntry } from "../../src/agent/mcp-oauth/store";
import { agentConfigDir } from "../../src/agent/oauth-home";
import { persistBrainGrant, BRAIN_SERVER_NAME } from "../../src/knowledge/remote/brain-grant";

const URL_ = "https://brain.example.com/mcp";
const tokens = { clientId: "c", accessToken: "tok-brain", refreshToken: "refresh-brain", expiresIn: 3600 };
const savedRole = process.env.SLAUDE_ROLE;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM mcp_credentials");
  rmSync(join(agentConfigDir(), ".credentials.json"), { force: true });
});
afterEach(() => {
  if (savedRole === undefined) delete process.env.SLAUDE_ROLE;
  else process.env.SLAUDE_ROLE = savedRole;
});

describe("persistBrainGrant", () => {
  test("on a gateway the grant goes to the store, and nothing is written to disk", async () => {
    process.env.SLAUDE_ROLE = "gateway";
    expect(await persistBrainGrant(URL_, tokens)).toBe("store");
    const got = await Creds.credentialsFor({ kind: "agent", tenant: "default", persona: "default" });
    expect(got[oauthKey(BRAIN_SERVER_NAME, { type: "http", url: URL_ })]!.refreshToken).toBe("refresh-brain");
    expect(existsSync(join(agentConfigDir(), ".credentials.json"))).toBe(false);
  });

  test("in mono the grant goes to the agent's config directory, as before", async () => {
    process.env.SLAUDE_ROLE = "mono";
    expect(await persistBrainGrant(URL_, tokens)).toBe("disk");
    expect(readEntry(agentConfigDir(), BRAIN_SERVER_NAME, { type: "http", url: URL_ })?.accessToken).toBe("tok-brain");
  });
});
