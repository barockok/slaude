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
import { db } from "../../db/schema";
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
  /** External MCP config ({servers, privateServices}) the node renders to mcp.json. */
  mcpJson: unknown;
  /** Skill roots in resolution order (base first, persona overlay last). */
  skillsPaths: string[];
  defaultModel: string;
}

type PersonaRow = {
  id: string;
  tenant_id: string;
  name: string;
  soul_md: string;
  soul_json: unknown;
  model_default: string | null;
  mcp_json: unknown;
};

type CredRow = { persona_id: string | null; kind: string; value: string };

async function buildBundle(tenantId: string): Promise<RuntimeBundle | null> {
  // The tenancy tables exist only on Postgres (P1 migrations). On sqlite the
  // queries throw "no such table" — treat that exactly like an empty registry
  // so the implicit 'default' tenant still serves from the file/env fallback.
  let tenant: { id: string } | null = null;
  let personas: PersonaRow[] = [];
  try {
    tenant = await db.one<{ id: string }>(`SELECT id FROM tenants WHERE id = ?`, [tenantId]);
    // Prefer the persona registry: the 'default'-named persona, else the first
    // by name (single-persona tenants).
    personas = await db.query<PersonaRow>(
      `SELECT * FROM personas WHERE tenant_id = ? ORDER BY CASE WHEN name = 'default' THEN 0 ELSE 1 END, name LIMIT 1`,
      [tenantId],
    );
  } catch {
    /* sqlite: no tenancy tables */
  }
  if (!tenant && tenantId !== "default") return null;
  const persona = personas[0];

  const providerCreds: RuntimeBundle["providerCreds"] = {};
  if (persona) {
    const creds = await db.query<CredRow>(
      `SELECT persona_id, kind, value FROM provider_creds
       WHERE tenant_id = ? AND (persona_id IS NULL OR persona_id = ?)`,
      [tenantId, persona.id],
    );
    // Tenant-wide rows first, persona-specific rows override.
    for (const specific of [false, true]) {
      for (const c of creds) {
        if ((c.persona_id !== null) !== specific) continue;
        if (c.kind === "api_key") providerCreds.apiKey = decrypt(c.value);
        else if (c.kind === "base_url") providerCreds.baseUrl = decrypt(c.value);
        else if (c.kind === "oauth_token") providerCreds.oauthToken = decrypt(c.value);
      }
    }
    const overlay = persona.name !== "default" ? [personaSkillsRoot(persona.name)] : [];
    return {
      tenantId,
      personaId: persona.name,
      providerCreds,
      soulMd: persona.soul_md,
      soulJson: typeof persona.soul_json === "string" ? JSON.parse(persona.soul_json) : persona.soul_json,
      mcpJson: typeof persona.mcp_json === "string" ? JSON.parse(persona.mcp_json) : persona.mcp_json,
      skillsPaths: [paths.skills, ...overlay],
      defaultModel: persona.model_default ?? env.model(),
    };
  }

  // Fallback (today's monolith): env + SOUL.md + mcp.json file loaders for the
  // default tenant. Non-default tenants must be registered in the tables.
  if (tenantId !== "default") return null;
  if (env.provider.apiKey()) providerCreds.apiKey = env.provider.apiKey();
  if (env.provider.baseUrl()) providerCreds.baseUrl = env.provider.baseUrl();
  if (env.provider.authToken()) providerCreds.authToken = env.provider.authToken();
  if (env.provider.oauthToken()) providerCreds.oauthToken = env.provider.oauthToken();
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
    mcpJson: loadExternalMcp(),
    skillsPaths: [paths.skills],
    defaultModel: env.model(),
  };
}

export async function handleTenantRuntime(req: Request, tenantId: string): Promise<Response> {
  const bundle = await buildBundle(tenantId);
  if (!bundle) return notFound("unknown tenant");
  const body = JSON.stringify(bundle);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", etag },
  });
}
