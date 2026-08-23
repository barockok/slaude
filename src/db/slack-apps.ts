/**
 * `slack_apps` repository — the multi-app registry the HTTP Slack transport
 * resolves inbound requests against (spec §4, §5). One row per installed
 * Slack app per workspace, keyed (api_app_id, team_id).
 *
 * `bot_token` and `signing_secret` are stored as AES-256-GCM envelopes
 * (src/db/crypto.ts, SLAUDE_MASTER_KEY) — never plaintext. `upsert` encrypts
 * plaintext inputs transparently and leaves already-enveloped values alone.
 *
 * Postgres-only: the table lives in src/db/migrations/0001_tenancy.sql and is
 * intentionally absent from the frozen sqlite bootstrap (it is allowlisted as
 * PG-only in tests/db/schema-drift.test.ts). HTTP Slack mode therefore
 * requires SLAUDE_DB=pg.
 *
 * Every function takes an optional DbClient so tests (and the CLI) can run
 * against an explicit PGLite instance instead of the process facade.
 */
import { db } from "./schema";
import type { DbClient } from "./client";
import { decrypt, encrypt, isEncrypted } from "./crypto";

export type SlackAppRow = {
  api_app_id: string;
  team_id: string;
  tenant_id: string;
  persona_id: string;
  /** Encrypted envelope (v1:iv:tag:ct). */
  bot_token: string;
  /** Encrypted envelope (v1:iv:tag:ct). */
  signing_secret: string;
  bot_user_id: string | null;
  created_at: number;
  updated_at: number;
};

export type SlackAppInput = {
  api_app_id: string;
  team_id: string;
  /** Defaults to the seeded 'default' tenant. */
  tenant_id?: string;
  persona_id?: string;
  /** Plaintext or an existing envelope; encrypted at rest either way. */
  bot_token: string;
  /** Plaintext or an existing envelope; encrypted at rest either way. */
  signing_secret: string;
  bot_user_id?: string | null;
};

const sealed = (v: string) => (isEncrypted(v) ? v : encrypt(v));

/** Insert or update the row for (api_app_id, team_id). Returns the stored row. */
export async function upsert(input: SlackAppInput, dbc: DbClient = db): Promise<SlackAppRow> {
  const now = Date.now();
  await dbc.run(
    `INSERT INTO slack_apps
       (api_app_id, team_id, tenant_id, persona_id, bot_token, signing_secret,
        bot_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (api_app_id, team_id) DO UPDATE SET
       tenant_id      = EXCLUDED.tenant_id,
       persona_id     = EXCLUDED.persona_id,
       bot_token      = EXCLUDED.bot_token,
       signing_secret = EXCLUDED.signing_secret,
       bot_user_id    = EXCLUDED.bot_user_id,
       updated_at     = EXCLUDED.updated_at`,
    [
      input.api_app_id,
      input.team_id,
      input.tenant_id ?? "default",
      input.persona_id ?? "default",
      sealed(input.bot_token),
      sealed(input.signing_secret),
      input.bot_user_id ?? null,
      now,
      now,
    ],
  );
  return (await find(input.api_app_id, input.team_id, dbc))!;
}

export async function find(
  apiAppId: string,
  teamId: string,
  dbc: DbClient = db,
): Promise<SlackAppRow | null> {
  return dbc.one<SlackAppRow>(
    `SELECT * FROM slack_apps WHERE api_app_id = ? AND team_id = ?`,
    [apiAppId, teamId],
  );
}

/** All workspaces one app is installed to (install model B; used by
 *  `url_verification`, which carries no team id). */
export async function findByApiAppId(apiAppId: string, dbc: DbClient = db): Promise<SlackAppRow[]> {
  return dbc.query<SlackAppRow>(
    `SELECT * FROM slack_apps WHERE api_app_id = ? ORDER BY created_at, team_id`,
    [apiAppId],
  );
}

export async function list(dbc: DbClient = db): Promise<SlackAppRow[]> {
  return dbc.query<SlackAppRow>(`SELECT * FROM slack_apps ORDER BY created_at, api_app_id, team_id`);
}

export async function remove(apiAppId: string, teamId: string, dbc: DbClient = db): Promise<boolean> {
  const r = await dbc.run(`DELETE FROM slack_apps WHERE api_app_id = ? AND team_id = ?`, [
    apiAppId,
    teamId,
  ]);
  return r.changes > 0;
}

/** Decrypt the row's secret columns. Throws MasterKeyError when the key is
 *  missing and on auth failure when the key is wrong. */
export function decryptTokens(row: SlackAppRow): { botToken: string; signingSecret: string } {
  return { botToken: decrypt(row.bot_token), signingSecret: decrypt(row.signing_secret) };
}
