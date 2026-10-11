/**
 * D1.2: a session records the Slack app its thread arrived through, so turns
 * with no inbound event (the operator panel) still carry the app into the job
 * token, and /v1 posts from them go out as that app. Checked on both dialects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { openDb, type DbClient } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as Sessions from "../../src/db/sessions";

describe("sessions.slack_app_id", () => {
  test("sqlite: unset on a new session, recorded by setSlackApp", async () => {
    const s = await Sessions.createForThread({
      thread: { team_id: "T0AAA", channel_id: "C_APP", thread_ts: `${Date.now()}.1` },
      model: "m",
      working_dir: "/tmp",
    });
    expect((await Sessions.findById(s.id))!.slack_app_id ?? null).toBeNull();
    await Sessions.setSlackApp(s.id, "A0TWO");
    expect((await Sessions.findById(s.id))!.slack_app_id).toBe("A0TWO");
    await db.run("DELETE FROM sessions WHERE id = ?", [s.id]);
  });

  let pg: DbClient;
  beforeAll(async () => {
    pg = await openDb({ dialect: "pg", driver: "pglite" });
    await runMigrations(pg, { log: () => {} });
  });
  afterAll(async () => {
    await pg?.close?.();
  });

  test("postgres: the migration adds a nullable slack_app_id column", async () => {
    const cols = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'slack_app_id'`,
    );
    expect(cols).toEqual([{ column_name: "slack_app_id", is_nullable: "YES" }]);
  });
});
