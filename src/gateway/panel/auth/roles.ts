/**
 * Operator role resolution (design §Authorization).
 *
 * Roles are declared by the deployment operator, never derived from provider
 * claims and never stored: a YAML file of two lists, or env fallbacks. The
 * resolver is pure — it knows nothing of HTTP, cookies, crypto, or the
 * provider — and is re-run on every request so a demotion lands immediately
 * rather than at the next token refresh.
 *
 * Failure policy is asymmetric on purpose. A malformed or unreadable file at
 * boot is fatal: assertPanelConfig() calls loadRoleConfig() before the panel is
 * mounted, and the throw below stops the process. A file that *becomes*
 * malformed while running keeps the last good config: a typo mid-shift must not
 * lock every operator out of a live fleet.
 */
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { env } from "../../../config/env";
import { SLAUDE_HOME } from "../../../config/home";

export type PanelRole = "superadmin" | "operator";

export interface RoleConfig {
  superadmin: string[];
  operator: string[];
}

function readList(doc: Record<string, unknown>, key: keyof RoleConfig): string[] {
  const raw = doc[key];
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`panel role file: '${key}' must be a list`);
  return raw.map((v) => {
    if (typeof v !== "string") throw new Error(`panel role file: '${key}' entries must be string identities`);
    return v.trim();
  }).filter(Boolean);
}

/** Parse a role file's text. Throws on anything that is not two string lists. */
export function parseRoleConfig(yamlText: string): RoleConfig {
  const doc = parseYaml(yamlText);
  if (doc == null) return { superadmin: [], operator: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("panel role file: top level must be a mapping of role name to list");
  }
  const rec = doc as Record<string, unknown>;
  return { superadmin: readList(rec, "superadmin"), operator: readList(rec, "operator") };
}

/** Identity → role. Exact, case-insensitive; superadmin wins over operator. */
export function resolveRole(identity: string, cfg: RoleConfig): PanelRole | null {
  const needle = identity.trim().toLowerCase();
  if (!needle) return null;
  if (cfg.superadmin.some((e) => e.toLowerCase() === needle)) return "superadmin";
  if (cfg.operator.some((e) => e.toLowerCase() === needle)) return "operator";
  return null;
}

let cached: { mtimeMs: number; path: string; cfg: RoleConfig } | null = null;

/** Test hook: forget the mtime cache. */
export function __resetRoleCache(): void {
  cached = null;
}

function rolesPath(): string | null {
  const explicit = env.panel.rolesFile();
  if (explicit) return explicit;
  const fallback = join(SLAUDE_HOME, "panel-roles.yaml");
  try {
    statSync(fallback);
    return fallback;
  } catch {
    return null;
  }
}

/**
 * Current role config. Reads the file when its mtime changed; falls back to the
 * env lists when no file is configured or discoverable.
 */
export function loadRoleConfig(): RoleConfig {
  const path = rolesPath();
  if (!path) return { superadmin: env.panel.superadmins(), operator: env.panel.operators() };

  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    if (cached && cached.path === path) return cached.cfg;
    throw new Error(`panel role file not readable: ${path}`);
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.cfg;

  try {
    const cfg = parseRoleConfig(readFileSync(path, "utf8"));
    cached = { mtimeMs, path, cfg };
    return cfg;
  } catch (e) {
    // Keep serving the last good config; a live fleet must not lose every
    // operator to one bad edit.
    console.error(`[panel] role file invalid, keeping last good config: ${(e as Error).message}`);
    if (cached && cached.path === path) return cached.cfg;
    throw e;
  }
}

/** Convenience used by the guard and the auth routes. */
export function resolveRoleForIdentity(identity: string): PanelRole | null {
  return resolveRole(identity, loadRoleConfig());
}
