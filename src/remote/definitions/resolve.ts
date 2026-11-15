/**
 * Where a definition row lives. `env:<name>` resolves with (tenant, name) here,
 * not through `src/refs/resolve.ts`. The id is tenant qualified and bounded, the
 * team is `def~<tenant>` (no Slack team id contains `~`), the owner column holds
 * the name, so two tenants' same-named definitions never share a row or a key.
 */
import { createHash } from "node:crypto";
import { DEFINITION_TEAM_PREFIX, type EnvRowShape } from "../../db/environments";
import type { DbClient } from "../../db/client";

/** `d` and the first 24 hex characters of sha256(tenant NUL name): 25 characters. */
export function definitionRowId(tenant: string, name: string): string {
  return "d" + createHash("sha256").update(`${tenant}\0${name}`).digest("hex").slice(0, 24);
}

/** The `team_id` of a tenant's definition rows (and of their key pairs). */
export const definitionTeam = (tenant: string): string => `${DEFINITION_TEAM_PREFIX}${tenant}`;

/** Every definition row of a tenant, retired ones included. */
export async function definitionRows(c: Pick<DbClient, "query">, tenant: string): Promise<EnvRowShape[]> {
  return c.query<EnvRowShape>("SELECT * FROM environments WHERE tenant_id = ? AND source = 'definition' ORDER BY name", [tenant]);
}

/** One tenant's definition row by name, or null. Retired rows are returned (the caller decides). */
export async function findDefinitionRow(c: Pick<DbClient, "one">, tenant: string, name: string): Promise<EnvRowShape | null> {
  return c.one<EnvRowShape>("SELECT * FROM environments WHERE tenant_id = ? AND definition_name = ?", [tenant, name]);
}
