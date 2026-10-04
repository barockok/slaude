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
 * gateway uses. ETag = HMAC of the bundle keyed by SLAUDE_MASTER_KEY;
 * If-None-Match → 304 so nodes can cache it (spec §6).
 *
 * A managed persona's `provider` references (WS-A §5) are resolved here, on
 * every build, so a session start, resume or reload reads the current secret;
 * a failure answers 503 with a fixed body.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPersonaRegistry } from "../../persona/registry";
import { db } from "../../db/schema";
import { resolveDbConfig } from "../../db/client";
import { effectivePersonas, isManaged } from "../../db/personas";
import type { EffectivePersona } from "../../persona/effective";
import { PROVIDER_FIELDS, type PersonaProvider } from "../../persona/sync/payload";
import { createSecretResolver, parseRef, SecretResolutionError, type SecretRef, type SecretResolver } from "../../secrets";
import { TRANSIENT_REASONS } from "../../secrets/errors";
import { baseUrlProblem, internalHostsFrom } from "../../persona/provider-base-url";
import { logResolveEvent } from "../core/provider-secrets";
import { decrypt, masterKey, MasterKeyError } from "../../db/crypto";
import { env } from "../../config/env";
import { loadSoul } from "../../soul/loader";
import { soulData } from "../../soul/extract";
import { skillRootsFor } from "../../skills/loader";
import { json, notFound } from "./http";
import { bridgedServerNames } from "../core/external-mcp";

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
  /** Always null. No node reads it, and on the disk tiers it was the shared,
   *  node-writable $SLAUDE_HOME/.mcp.json with ${VAR} placeholders expanded
   *  against the gateway's environment, so a planted placeholder could carry a
   *  gateway secret to a node. Kept in the shape for older nodes. */
  mcpJson: null;
  /** The persona's remote MCP servers a node mounts through the MCP bridge
   *  (WS-C §4.2): NAMES only — no URL, header or secret reaches a node. Its
   *  OAuth-connectable http servers (stdio, sse and plugin servers are not
   *  bridged). A node that predates the bridge ignores the field. */
  mcpServers: string[];
  /** Skill roots in resolution order (base first, persona overlay last). */
  skillsPaths: string[];
  /** The persona's default model: on a managed tenant its effective model (git
   *  or override), else SLAUDE_MODEL. A node applies it only when `managed`. */
  defaultModel: string;
  /** Present (true) only on a managed tenant's bundle. Unmanaged bundles omit
   *  it, so their content and ETag are exactly as before. */
  managed?: true;
  /** Present (true) when the persona declares its own `provider`: providerCreds
   *  is exactly that set, and a node must not fill a missing field (or any
   *  other provider-selecting variable) from its own environment. */
  ownProvider?: true;
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

/** provider_creds.kind → the bundle key it fills. */
const CRED_KINDS: Record<string, keyof RuntimeBundle["providerCreds"]> = {
  api_key: "apiKey",
  base_url: "baseUrl",
  oauth_token: "oauthToken",
  auth_token: "authToken",
};

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
      const key = Object.hasOwn(CRED_KINDS, c.kind) ? CRED_KINDS[c.kind] : undefined;
      if (key) out[key] = decrypt(c.value);
    }
  }
}

/**
 * The resolver for provider references. The gateway installs one built from
 * its environment at boot (src/gateway/core/provider-secrets.ts, which adds
 * Vault); until then, and in tests, env:// references resolve against this
 * process's environment and a vault:// reference fails as "disabled".
 */
let secretResolver: SecretResolver | null = null;
export function setProviderSecretResolver(r: SecretResolver | null): void {
  secretResolver = r;
}
function providerSecretResolver(): SecretResolver {
  return (secretResolver ??= createSecretResolver({ env: process.env, onEvent: logResolveEvent }));
}

/**
 * A persona that DECLARES `provider` (any field set) gets exactly that set,
 * resolved: nothing is filled in from the provider_creds rows here, nor from
 * the node's environment there (the bundle says `ownProvider`). A persona's
 * key therefore only ever goes to the host the same persona names, and its
 * host only ever receives its own key (review M-1). The base URL, literal or
 * resolved, is re-checked against the baseUrl policy, and a set with no
 * credential is refused, so a row written some other way cannot bypass sync.
 * Any failure throws SecretResolutionError; the caller answers 503.
 */
async function resolveDeclaredProvider(persona: string, provider: PersonaProvider): Promise<RuntimeBundle["providerCreds"]> {
  const resolver = providerSecretResolver();
  const resolved = await Promise.all(
    PROVIDER_FIELDS.map(async (field) => {
      const v = provider[field];
      if (!v) return [field, undefined] as const;
      if (field === "baseUrl" && !v.startsWith("vault://") && !v.startsWith("env://")) return [field, v] as const;
      let ref: SecretRef;
      try {
        ref = parseRef(v);
      } catch {
        // A stored row that no longer parses: never resolve it, never echo it.
        throw new SecretResolutionError("invalid_ref", "stored provider reference does not parse");
      }
      return [field, await resolver.resolve(ref, { persona })] as const;
    }),
  );
  const out: RuntimeBundle["providerCreds"] = {};
  for (const [field, value] of resolved) if (value !== undefined) out[field] = value;
  if (!out.apiKey && !out.authToken && !out.oauthToken) {
    throw new SecretResolutionError("invalid_value", "provider has no credential");
  }
  if (out.baseUrl !== undefined && baseUrlProblem(out.baseUrl, internalHostsFrom(process.env))) {
    console.error(`[provider.cred.resolve] persona=${persona} field=baseUrl outcome=denied reason=invalid_value`);
    throw new SecretResolutionError("invalid_value", "provider baseUrl is outside the baseUrl policy");
  }
  return out;
}

const declaresProvider = (p: PersonaProvider | null | undefined): p is PersonaProvider =>
  !!p && PROVIDER_FIELDS.some((f) => p[f]);

/** A managed tenant: effective state only. Self-contained, so tiers 2 and 3
 *  (disk, env) are unreachable from it. Missing or tombstoned persona -> null. */
async function buildManagedBundle(tenantId: string, personaId: string): Promise<RuntimeBundle | null> {
  const effective = (await effectivePersonas(tenantId)).find((p) => p.name === personaId);
  if (!effective) return null;
  const own = declaresProvider(effective.provider);
  let providerCreds: RuntimeBundle["providerCreds"];
  if (own) {
    providerCreds = await resolveDeclaredProvider(effective.name, effective.provider as PersonaProvider);
  } else {
    // No declared provider: the read-only rows, persona over tenant, per field.
    const row = await db.one<{ id: string }>(`SELECT id FROM personas WHERE tenant_id = ? AND name = ?`, [tenantId, personaId]);
    providerCreds = {};
    await applyProviderCreds(providerCreds, tenantId, row?.id);
  }
  return {
    tenantId,
    personaId: effective.name,
    providerCreds,
    ...(own ? { ownProvider: true as const } : {}),
    soulMd: effective.soulMd,
    soulJson: effective.soulJson,
    slackUserId: effective.slackUserId ?? null,
    // A persona's mcp holds resolved header and env secrets: a node gets the
    // bridged server names below, never the config.
    mcpJson: null,
    mcpServers: bridgedServerNames(effective.name),
    skillsPaths: skillRootsFor(effective.name),
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
    return {
      tenantId,
      personaId: persona.name,
      providerCreds,
      soulMd: persona.soul_md,
      soulJson: typeof persona.soul_json === "string" ? JSON.parse(persona.soul_json) : persona.soul_json,
      slackUserId: persona.slack_user_id ?? null,
      mcpJson: null,
      mcpServers: bridgedServerNames(persona.name),
      skillsPaths: skillRootsFor(persona.name),
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
      mcpJson: null,
      mcpServers: bridgedServerNames(personaId),
      skillsPaths: skillRootsFor(personaId),
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
    mcpJson: null,
    mcpServers: bridgedServerNames(undefined),
    skillsPaths: skillRootsFor(),
    defaultModel: env.model(),
  };
}

/** The whole 503 body when a provider credential cannot be resolved. A node
 *  maps it to the typed failure code; nothing else is said but whether the
 *  cause is transient (Vault not answering: retry later) or definitive (a
 *  denial, a missing secret, a bad reference: retrying cannot help). */
export function providerUnavailableBody(transient: boolean) {
  return { error: "provider credentials unavailable", code: "PROVIDER_CREDENTIALS_UNAVAILABLE", transient } as const;
}
/** Seconds a node should wait before retrying a transient failure. */
export const PROVIDER_RETRY_AFTER_SEC = 5;

/**
 * ETag = HMAC-SHA256 of the body (WS-A §8). The body holds plaintext provider
 * credentials, so a bare hash would let anyone who sees the tag (a proxy log)
 * test a guessed key against it offline. Keyed by a subkey of SLAUDE_MASTER_KEY
 * so every replica agrees (a node's 304 survives landing on another replica).
 * Without a master key (an unmanaged single process) a random per-process key
 * keeps the property; the only cost is a 200 instead of a 304 across restarts.
 */
let fallbackEtagKey: Buffer | null = null;
function etagKey(): Buffer {
  try {
    return createHmac("sha256", masterKey()).update("slaude/runtime-bundle-etag/v1").digest();
  } catch (e) {
    if (!(e instanceof MasterKeyError)) throw e;
    return (fallbackEtagKey ??= randomBytes(32));
  }
}
function bundleEtag(body: string): string {
  return createHmac("sha256", etagKey()).update(body).digest("hex");
}
/** TEST SEAM: a fresh per-process fallback key, as a new process would have. */
export function __resetEtagKeyForTests(): void {
  fallbackEtagKey = null;
}
/** TEST SEAM: the ETag this process gives a body. */
export const bundleEtagForTests = bundleEtag;

export async function handleTenantRuntime(
  req: Request,
  tenantId: string,
  personaId: string,
): Promise<Response> {
  let bundle: RuntimeBundle | null;
  try {
    bundle = await buildBundle(tenantId, personaId);
  } catch (e) {
    // The resolver already logged persona, scheme and reason. The body is
    // fixed: the reason, path and value stay on the gateway (WS-A §7).
    if (e instanceof SecretResolutionError) {
      const transient = TRANSIENT_REASONS.has(e.reason);
      return new Response(JSON.stringify(providerUnavailableBody(transient)), {
        status: 503,
        headers: {
          "content-type": "application/json",
          ...(transient ? { "retry-after": String(PROVIDER_RETRY_AFTER_SEC) } : {}),
        },
      });
    }
    throw e;
  }
  if (!bundle) return notFound("unknown tenant or persona");
  const body = JSON.stringify(bundle);
  const etag = `"${bundleEtag(body)}"`;
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
