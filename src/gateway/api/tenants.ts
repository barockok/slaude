/**
 * GET /v1/tenants/:id/runtime — the runtime bundle a node needs to boot a
 * session's SDK child (spec §3): provider credentials (decrypted), SOUL.md
 * text, structured soul JSON, external MCP config, skills overlay paths, and
 * the default model.
 *
 * Source of truth is the `personas` / `provider_creds` tables (P1 migrations).
 * Today's monolith reality: real deploys have an empty personas table, so the
 * `default` tenant falls back to the current file/env loaders (SOUL.md,
 * ~/.slaude/mcp.json, ANTHROPIC_* env) — the same inputs the in-process
 * gateway uses. ETag = sha256 of the bundle; If-None-Match → 304 so nodes can
 * cache it (spec §6).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPersonaRegistry } from "../../persona/registry";
import { db } from "../../db/schema";
import { resolveDbConfig } from "../../db/client";
import { effectivePersonas, isManaged } from "../../db/personas";
import type { EffectivePersona } from "../../persona/effective";
import { decrypt } from "../../db/crypto";
import { env } from "../../config/env";
import { paths } from "../../config/home";
import { loadSoul } from "../../soul/loader";
import { soulData } from "../../soul/extract";
import { loadExternalMcp } from "../core/external-mcp";
import { personaSkillsRoot } from "../../skills/loader";
import { json, notFound } from "./http";

export interface RuntimeBundle {
  tenantId: string;
  /** Persona the bundle was resolved from ('default' in single-bot mode). */
  personaId: string;
  /** Decrypted provider credentials. Keys mirror provider_creds.kind. */
  providerCreds: { apiKey?: string; baseUrl?: string; oauthToken?: string; authToken?: string };
  soulMd: string;
  soulJson: unknown;
  /** The persona's Slack user id (not a secret): a node sets it as the child's
   *  SLAUDE_AGENT_ID, the anchor of a named persona's private brain slice.
   *  null for the default persona's env tier, or when the persona has none. */
  slackUserId: string | null;
  /** External MCP config ({servers, privateServices}) the node renders to mcp.json. */
  mcpJson: unknown;
  /** Skill roots in resolution order (base first, persona overlay last). */
  skillsPaths: string[];
  /** The persona's default model: on a managed tenant its effective model (git
   *  or override), else SLAUDE_MODEL. A node applies it only when `managed`. */
  defaultModel: string;
  /** Present (true) only on a managed tenant's bundle. Unmanaged bundles omit
   *  it, so their content and ETag are exactly as before. */
  managed?: true;
}

type PersonaRow = {
  id: string;
  tenant_id: string;
  name: string;
  soul_md: string;
  soul_json: unknown;
  slack_user_id?: string | null;
  model_default: string | null;
  mcp_json: unknown;
};

type CredRow = { persona_id: string | null; kind: string; value: string };

/** Provider credentials from the process environment — the single-bot fallback,
 *  shared by the filesystem-persona tier and the default tier. */
function envProviderCreds(): RuntimeBundle["providerCreds"] {
  const creds: RuntimeBundle["providerCreds"] = {};
  if (env.provider.apiKey()) creds.apiKey = env.provider.apiKey();
  if (env.provider.baseUrl()) creds.baseUrl = env.provider.baseUrl();
  if (env.provider.authToken()) creds.authToken = env.provider.authToken();
  if (env.provider.oauthToken()) creds.oauthToken = env.provider.oauthToken();
  return creds;
}

/** Tenant-wide provider creds first, then the persona's own (when it has a row). */
async function applyProviderCreds(out: RuntimeBundle["providerCreds"], tenantId: string, personaRowId: string | undefined) {
  const creds = personaRowId === undefined
    ? await db.query<CredRow>(`SELECT persona_id, kind, value FROM provider_creds WHERE tenant_id = ? AND persona_id IS NULL`, [tenantId])
    : await db.query<CredRow>(
        `SELECT persona_id, kind, value FROM provider_creds
         WHERE tenant_id = ? AND (persona_id IS NULL OR persona_id = ?)`,
        [tenantId, personaRowId],
      );
  for (const specific of [false, true]) {
    for (const c of creds) {
      if ((c.persona_id !== null) !== specific) continue;
      if (c.kind === "api_key") out.apiKey = decrypt(c.value);
      else if (c.kind === "base_url") out.baseUrl = decrypt(c.value);
      else if (c.kind === "oauth_token") out.oauthToken = decrypt(c.value);
    }
  }
}

/** A managed tenant: effective state only. Self-contained, so tiers 2 and 3
 *  (disk, env) are unreachable from it. Missing or tombstoned persona -> null. */
async function buildManagedBundle(tenantId: string, personaId: string): Promise<RuntimeBundle | null> {
  const effective = (await effectivePersonas(tenantId)).find((p) => p.name === personaId);
  if (!effective) return null;
  const row = await db.one<{ id: string }>(`SELECT id FROM personas WHERE tenant_id = ? AND name = ?`, [tenantId, personaId]);
  const providerCreds: RuntimeBundle["providerCreds"] = {};
  await applyProviderCreds(providerCreds, tenantId, row?.id);
  return {
    tenantId,
    personaId: effective.name,
    providerCreds,
    soulMd: effective.soulMd,
    soulJson: effective.soulJson,
    slackUserId: effective.slackUserId ?? null,
    // Nodes never consume a persona's mcp (no node-side mounting yet), and its
    // header and env values are resolved secrets: ship nothing a node does not use.
    mcpJson: null,
    skillsPaths: [paths.skills, ...(effective.name !== "default" ? [personaSkillsRoot(effective.name)] : [])],
    defaultModel: effective.model ?? env.model(),
    managed: true,
  };
}

/**
 * Resolve the bundle for one (tenant, persona) pair, in three tiers:
 *
 *   1. the persona row in the DB — the eventual source of truth;
 *   2. the persona directory on disk — what actually drives multi-persona
 *      deploys today, since nothing populates the persona tables yet;
 *   3. the env/file fallback, for the implicit `default` persona.
 *
 * Selecting the REQUESTED persona is the fix: this previously took whichever
 * persona sorted first in the tenant, so a second persona could never get its
 * own bundle.
 */
async function buildBundle(tenantId: string, personaId: string): Promise<RuntimeBundle | null> {
  // The tenancy tables exist only on Postgres (P1 migrations). sqlite is decided
  // from configuration, never from a caught error: it is unmanaged, and its
  // "no such table" failures read as an empty registry so the implicit
  // 'default' tenant still serves from the file/env fallback. On Postgres every
  // error propagates (the route 500s, the node retries): swallowing one would
  // read as "unmanaged" and flip a managed tenant onto the disk tier.
  const sqlite = resolveDbConfig().dialect === "sqlite";
  // Managed is decided FIRST, so everything after reads one consistent answer.
  const managed = sqlite ? false : await isManaged(tenantId);
  if (managed) return buildManagedBundle(tenantId, personaId);

  // Unmanaged: today's raw-row tier 1, then tiers 2 and 3.
  let tenant: { id: string } | null = null;
  let personas: PersonaRow[] = [];
  const loadRows = async () => {
    tenant = await db.one<{ id: string }>(`SELECT id FROM tenants WHERE id = ?`, [tenantId]);
    return db.query<PersonaRow>(`SELECT * FROM personas WHERE tenant_id = ? AND name = ?`, [tenantId, personaId]);
  };
  if (sqlite) {
    try {
      personas = await loadRows();
    } catch {
      /* sqlite: no tenancy tables */
    }
  } else {
    personas = await loadRows();
  }
  if (!tenant && tenantId !== "default") return null;
  const persona = personas[0];

  const providerCreds: RuntimeBundle["providerCreds"] = {};
  if (persona) {
    await applyProviderCreds(providerCreds, tenantId, persona.id);
    const overlay = persona.name !== "default" ? [personaSkillsRoot(persona.name)] : [];
    return {
      tenantId,
      personaId: persona.name,
      providerCreds,
      soulMd: persona.soul_md,
      soulJson: typeof persona.soul_json === "string" ? JSON.parse(persona.soul_json) : persona.soul_json,
      slackUserId: persona.slack_user_id ?? null,
      mcpJson: typeof persona.mcp_json === "string" ? JSON.parse(persona.mcp_json) : persona.mcp_json,
      skillsPaths: [paths.skills, ...overlay],
      defaultModel: persona.model_default ?? env.model(),
    };
  }

  // Tier 2: the persona directory on disk. Nothing populates the persona tables
  // yet, so without this a named persona would fall through to the default
  // bundle and silently run on another agent's soul and skills overlay.
  if (personaId !== "default") {
    // NOTE: the filesystem registry is deploy-global — it has no tenant
    // dimension, so this tier cannot check that the persona belongs to the
    // REQUESTED tenant. Safe today because one deploy owns one workspace and a
    // persona name can only be one this deploy already loaded from disk, but it
    // becomes a cross-tenant read the moment two tenants share a deploy. The DB
    // tier above is tenant-scoped; this tier must be removed, or gain a tenant
    // column, before multi-tenant deploys are supported.
    const fsPersona = getPersonaRegistry().lookupByName(personaId);
    if (!fsPersona) return null;
    let personaSoul = "";
    // A database-backed persona has no soulPath: it ships the empty soul here
    // until this tier is rewritten to serve effective state.
    if (fsPersona.soulPath) {
      try {
        personaSoul = readFileSync(fsPersona.soulPath, "utf8");
      } catch {
        /* persona has no readable SOUL.md — bundle ships an empty soul */
      }
    }
    return {
      tenantId,
      personaId,
      providerCreds: envProviderCreds(),
      soulMd: personaSoul,
      soulJson: null,
      slackUserId: fsPersona.slackUserId ?? null,
      mcpJson: loadExternalMcp(),
      skillsPaths: [paths.skills, personaSkillsRoot(personaId)],
      defaultModel: env.model(),
    };
  }

  // Tier 3 (today's monolith): env + SOUL.md + mcp.json file loaders for the
  // default tenant. Non-default tenants must be registered in the tables.
  if (tenantId !== "default") return null;
  Object.assign(providerCreds, envProviderCreds());
  let soulMd = "";
  try {
    soulMd = loadSoul();
  } catch {
    /* no SOUL.md on disk — bundle ships an empty soul */
  }
  let soulJson: unknown = null;
  try {
    soulJson = soulData();
  } catch {
    /* structured extraction unavailable */
  }
  return {
    tenantId,
    personaId: "default",
    providerCreds,
    soulMd,
    soulJson,
    slackUserId: null,
    mcpJson: loadExternalMcp(),
    skillsPaths: [paths.skills],
    defaultModel: env.model(),
  };
}

export async function handleTenantRuntime(
  req: Request,
  tenantId: string,
  personaId: string,
): Promise<Response> {
  const bundle = await buildBundle(tenantId, personaId);
  if (!bundle) return notFound("unknown tenant or persona");
  const body = JSON.stringify(bundle);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const inm = req.headers.get("if-none-match");
  // RFC 7232 §3.2: "*" matches any current representation; otherwise compare
  // against each listed entity-tag.
  if (inm && (inm.trim() === "*" || inm.split(",").map((s) => s.trim()).includes(etag))) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", etag },
  });
}
