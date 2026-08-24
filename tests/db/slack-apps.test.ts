import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { openDb, type DbClient } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { __resetMasterKeyCache, isEncrypted } from "../../src/db/crypto";
import * as SlackApps from "../../src/db/slack-apps";

let dbc: DbClient;
let prevKey: string | undefined;

beforeAll(async () => {
  prevKey = process.env.SLAUDE_MASTER_KEY;
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();
  dbc = await openDb({ dialect: "pg", driver: "pglite" });
  await runMigrations(dbc, { log: () => {} });
});

afterAll(async () => {
  await dbc.close();
  if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = prevKey;
  __resetMasterKeyCache();
});

describe("slack_apps repo", () => {
  it("upsert encrypts secrets at rest and decryptTokens round-trips", async () => {
    const row = await SlackApps.upsert(
      {
        api_app_id: "A0AAA",
        team_id: "T0AAA",
        bot_token: "xoxb-round-trip",
        signing_secret: "shhh-secret",
        bot_user_id: "U0BOT",
      },
      dbc,
    );
    expect(row.tenant_id).toBe("default");
    expect(row.persona_id).toBe("default");
    expect(row.bot_user_id).toBe("U0BOT");
    // Stored ciphertext, not plaintext.
    expect(isEncrypted(row.bot_token)).toBe(true);
    expect(isEncrypted(row.signing_secret)).toBe(true);
    expect(row.bot_token).not.toContain("xoxb-round-trip");
    const secrets = SlackApps.decryptTokens(row);
    expect(secrets.botToken).toBe("xoxb-round-trip");
    expect(secrets.signingSecret).toBe("shhh-secret");
  });

  it("upsert on the same (api_app_id, team_id) updates in place", async () => {
    const first = await SlackApps.upsert(
      { api_app_id: "A0UPD", team_id: "T0UPD", bot_token: "xoxb-1", signing_secret: "s1" },
      dbc,
    );
    const second = await SlackApps.upsert(
      {
        api_app_id: "A0UPD",
        team_id: "T0UPD",
        bot_token: "xoxb-2",
        signing_secret: "s2",
        bot_user_id: "U0NEW",
        persona_id: "maria",
      },
      dbc,
    );
    expect(second.created_at).toBeGreaterThanOrEqual(first.created_at);
    expect(second.persona_id).toBe("maria");
    expect(second.bot_user_id).toBe("U0NEW");
    expect(SlackApps.decryptTokens(second).botToken).toBe("xoxb-2");
    const all = await SlackApps.findByApiAppId("A0UPD", dbc);
    expect(all.length).toBe(1);
  });

  it("does not double-encrypt an already-enveloped value", async () => {
    const row = await SlackApps.upsert(
      { api_app_id: "A0ENV", team_id: "T0ENV", bot_token: "xoxb-plain", signing_secret: "sec" },
      dbc,
    );
    // Re-upsert passing back the stored envelopes untouched.
    const again = await SlackApps.upsert(
      {
        api_app_id: "A0ENV",
        team_id: "T0ENV",
        bot_token: row.bot_token,
        signing_secret: row.signing_secret,
      },
      dbc,
    );
    expect(again.bot_token).toBe(row.bot_token);
    expect(SlackApps.decryptTokens(again).botToken).toBe("xoxb-plain");
  });

  it("find is exact on the (api_app_id, team_id) pair", async () => {
    await SlackApps.upsert(
      { api_app_id: "A0F", team_id: "T0F1", bot_token: "b1", signing_secret: "s1" },
      dbc,
    );
    expect(await SlackApps.find("A0F", "T0F1", dbc)).not.toBeNull();
    expect(await SlackApps.find("A0F", "T0OTHER", dbc)).toBeNull();
    expect(await SlackApps.find("A0NOPE", "T0F1", dbc)).toBeNull();
  });

  it("findByApiAppId returns every workspace the app is installed to", async () => {
    await SlackApps.upsert(
      { api_app_id: "A0MULTI", team_id: "T0W1", bot_token: "b", signing_secret: "s" },
      dbc,
    );
    await SlackApps.upsert(
      { api_app_id: "A0MULTI", team_id: "T0W2", bot_token: "b", signing_secret: "s" },
      dbc,
    );
    const rows = await SlackApps.findByApiAppId("A0MULTI", dbc);
    expect(rows.map((r) => r.team_id).sort()).toEqual(["T0W1", "T0W2"]);
  });

  it("list and remove", async () => {
    await SlackApps.upsert(
      { api_app_id: "A0RM", team_id: "T0RM", bot_token: "b", signing_secret: "s" },
      dbc,
    );
    expect((await SlackApps.list(dbc)).some((r) => r.api_app_id === "A0RM")).toBe(true);
    expect(await SlackApps.remove("A0RM", "T0RM", dbc)).toBe(true);
    expect(await SlackApps.remove("A0RM", "T0RM", dbc)).toBe(false);
    expect((await SlackApps.list(dbc)).some((r) => r.api_app_id === "A0RM")).toBe(false);
  });
});
