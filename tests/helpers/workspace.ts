import { db } from "../../src/db/schema";

/** One connected Slack workspace for a tenant, so a sync can place its short Slack references. Postgres only. */
export async function seedWorkspace(tenant = "default", team = "T0EXAMPLE", app = `A-${tenant}-${team}`): Promise<void> {
  const now = Date.now();
  await db.run(`INSERT INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', ?) ON CONFLICT (id) DO NOTHING`, [tenant, tenant, now]);
  await db.run(
    `INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'y', ?, ?) ON CONFLICT (api_app_id, team_id) DO NOTHING`,
    [app, team, tenant, now, now],
  );
}

export async function clearWorkspaces(): Promise<void> {
  await db.run("DELETE FROM slack_apps");
}
