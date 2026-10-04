/**
 * The sync payload a pipeline POSTs, and the one place placeholders resolve.
 *
 * Resolution touches userToken and the mcp object only. Soul text is content:
 * a soul can document a template and legitimately contain `${...}`, and
 * resolving it would silently rewrite what the agent says.
 *
 * Only variables named PERSONA_* resolve. The gateway's environment also holds
 * its own secrets (master key, job secret, node token, provider keys), and a
 * persona repository must not be able to copy one into a stored persona.
 */
import { z } from "zod";
import { redactSecrets } from "../../gateway/core/status-text";
import { PERSONA_VAR_PREFIX, PERSONA_VAR_RE } from "../../secrets/persona-var";
import { parseRef } from "../../secrets/ref";
import { baseUrlProblem, internalHostsFrom } from "../provider-base-url";
import { PayloadError } from "./errors";

export { PayloadError };

export const PERSONA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export class UnresolvedVarError extends PayloadError {
  constructor(readonly variable: string) {
    super(`unresolved variable \${${variable}} — set it in the gateway's environment`);
  }
}

/**
 * The payload format this gateway understands. A payload with no `version` is
 * version 1. A newer one is refused rather than half-applied: its extra fields
 * might change what a persona means.
 *
 *   1  the personas-as-code fields
 *   2  adds `provider` (WS-A)
 *   3  adds `kbSources` (WS-C §4.1)
 *
 * Each persona field newer than version 1 is one entry in PERSONA_FIELD_VERSION.
 * `render` writes the highest version any field a persona sets needs, so a
 * gateway that predates a field refuses the payload instead of dropping it
 * (which would leave a persona on node credentials, or widen it to every KB);
 * a payload that sets none stays 1 and deploys to any gateway.
 */
export const PERSONA_FIELD_VERSION = { provider: 2, kbSources: 3 } as const;
export const SUPPORTED_PAYLOAD_VERSION = 3;
export const PROVIDER_PAYLOAD_VERSION = PERSONA_FIELD_VERSION.provider;
export const KB_SOURCES_PAYLOAD_VERSION = PERSONA_FIELD_VERSION.kbSources;

/** The version a payload needs: the highest of any field a persona sets, 1 when none. */
export function payloadVersionFor(personas: ReadonlyArray<object>): number {
  let v = 1;
  for (const p of personas) {
    for (const [field, need] of Object.entries(PERSONA_FIELD_VERSION)) {
      if ((p as Record<string, unknown>)[field] !== undefined) v = Math.max(v, need);
    }
  }
  return v;
}

/** A knowledge-base source id as kbSourceId() builds it from an installed KB's
 *  label: `kb-` and at most 29 more characters (gbrain ids are ≤ 32). */
export const KB_SOURCE_ID_RE = /^kb-[a-z0-9][a-z0-9-]{0,28}$/;
/** Most ids one persona may list. */
export const KB_SOURCES_MAX = 64;

const personaSpec = z.object({
  name: z.string().regex(PERSONA_NAME_RE, "persona name must match ^[a-z0-9][a-z0-9-]{0,62}$"),
  slackUserId: z.string().min(1).optional(),
  userToken: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  soul: z.string(),
  mcp: z.record(z.unknown()).optional(),
  // Shape only here; parseProvider below checks every key and value with
  // messages that never echo a value (zod's would echo an unknown key).
  provider: z.record(z.unknown()).optional(),
  // The KB sources this persona may read; absent = every installed KB. Each id
  // is checked by parseKbSources below. Desired layer only, not overridable.
  kbSources: z.array(z.unknown()).optional(),
});

/**
 * Where a persona's LLM provider credentials are (WS-A §4). Each secret field
 * is a reference (`vault://…#field` or `env://PERSONA_*`), never a value;
 * `baseUrl` is not a secret and may be a literal http(s) URL or a reference.
 */
export type PersonaProvider = { apiKey?: string; authToken?: string; oauthToken?: string; baseUrl?: string };
export const PROVIDER_SECRET_FIELDS = ["apiKey", "authToken", "oauthToken"] as const;
export const PROVIDER_FIELDS = [...PROVIDER_SECRET_FIELDS, "baseUrl"] as const;
export type ProviderField = (typeof PROVIDER_FIELDS)[number];

export type PersonaSpec = Omit<z.infer<typeof personaSpec>, "provider" | "kbSources"> & {
  provider?: PersonaProvider;
  kbSources?: string[];
};

/**
 * Validate one persona's `kbSources` (WS-C §4.1.5): each id must have the
 * `kb-<label>` shape, once. Whether it matches an INSTALLED KB is a warning at
 * sync (kbSourceWarnings), since the installer and the sync land independently.
 * Errors name the persona and the position, never the value.
 */
export function parseKbSources(persona: string, raw: unknown[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > KB_SOURCES_MAX) throw new PayloadError(`persona '${persona}': kbSources lists ${raw.length} ids; at most ${KB_SOURCES_MAX}`);
  const seen = new Set<string>();
  raw.forEach((v, i) => {
    if (typeof v !== "string" || !KB_SOURCE_ID_RE.test(v)) {
      throw new PayloadError(`persona '${persona}': kbSources[${i}] is not a knowledge-base source id (kb-<label>, ${KB_SOURCE_ID_RE.source})`);
    }
    if (seen.has(v)) throw new PayloadError(`persona '${persona}': kbSources[${i}] repeats an earlier id`);
    seen.add(v);
  });
  return raw as string[];
}

/** Sync warnings for kbSources ids that match no installed KB (names the persona and id). */
export function kbSourceWarnings(payload: Pick<SyncPayload, "personas">, installed: readonly string[]): string[] {
  // `installed` holds one id per installed KB: two labels that normalise to
  // the same id appear twice, and a persona listing it reads both.
  const count = new Map<string, number>();
  for (const id of installed) count.set(id, (count.get(id) ?? 0) + 1);
  const out: string[] = [];
  for (const p of payload.personas) {
    for (const id of p.kbSources ?? []) {
      const n = count.get(id) ?? 0;
      if (n === 0) out.push(`persona '${p.name}' lists ${id} in kbSources, but no such knowledge base is installed; it reads nothing from it until one is`);
      else if (n > 1) out.push(`persona '${p.name}' lists ${id} in kbSources, which more than one installed knowledge base maps to (their labels normalise to the same id); it reads all of them`);
    }
  }
  return out;
}

const payloadSchema = z.object({
  version: z.number().int().min(1).default(1),
  revision: z.string().min(1),
  committedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "committedAt must be an ISO 8601 instant"),
  allowEmpty: z.boolean().default(false),
  personas: z.array(personaSpec),
});
export type SyncPayload = Omit<z.infer<typeof payloadSchema>, "personas"> & { personas: PersonaSpec[] };

const isRefShaped = (v: string) => v.startsWith("vault://") || v.startsWith("env://");

/**
 * Validate one persona's `provider` object. Secret fields must be references
 * (the same parseRef the gateway resolves with, so `render --check` and /deploy
 * agree); `baseUrl` is a reference or an https URL under the baseUrl policy
 * (src/persona/provider-base-url.ts), and needs a credential beside it.
 * Unknown keys are refused rather than dropped: a misspelt `apikey` would
 * otherwise leave the persona silently on the node's own credentials. Errors
 * name the persona and field, never a value. An empty object is absent.
 */
export function parseProvider(
  persona: string,
  raw: Record<string, unknown> | undefined,
  internalHosts: readonly string[] = [],
): PersonaProvider | undefined {
  if (raw === undefined) return undefined;
  const known = new Set<string>(PROVIDER_FIELDS);
  const out: PersonaProvider = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) {
      throw new PayloadError(`persona '${persona}': provider.${safeKey(k)} is not a provider field (${PROVIDER_FIELDS.join(", ")})`);
    }
    const field = k as ProviderField;
    const label = `persona '${persona}': provider.${field}`;
    if (typeof v !== "string" || v === "") throw new PayloadError(`${label} must be a non-empty string`);
    if (field === "baseUrl" && !isRefShaped(v)) {
      const problem = baseUrlProblem(v, internalHosts);
      if (problem) throw new PayloadError(`${label} ${problem}`);
    } else {
      parseRef(v, label);
    }
    out[field] = v;
  }
  // `provider` is one atomic set: a persona's key is only ever sent to the host
  // the same persona names, and its host only ever receives its own key. A
  // baseUrl with no credential would pair it with someone else's (M-1).
  if (out.baseUrl && !PROVIDER_SECRET_FIELDS.some((f) => out[f])) {
    throw new PayloadError(
      `persona '${persona}': provider.baseUrl needs a credential reference in the same provider object (apiKey, authToken or oauthToken)`,
    );
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Sync warnings for the provider/model pairing (WS-A §4): a persona that sets
 * `provider.baseUrl` with no `model`, and any named persona with no model at
 * all, which inherits the gateway's default, a model its own provider may not
 * have ("model not found" on every turn). The default persona's model IS the
 * gateway default, so it only warns there when it also sets a baseUrl.
 */
export function providerWarnings(payload: Pick<SyncPayload, "personas">): string[] {
  const out: string[] = [];
  for (const p of payload.personas) {
    if (p.model) continue;
    if (p.provider?.baseUrl) {
      out.push(`persona '${p.name}' sets provider.baseUrl but no model; it will run the gateway's default model on that provider`);
    } else if (p.name !== "default" || p.provider) {
      out.push(`persona '${p.name}' has no model; it inherits the gateway's default, which its provider may not offer`);
    }
  }
  return out;
}

const PERSONA_KEYS = new Set(Object.keys(personaSpec.shape));
const TOP_KEYS = new Set(Object.keys(payloadSchema.shape));
// A key is echoed in messages, so only a plain identifier-shaped one is (no
// '.', which would let a top-level key pose as a persona path) and one the
// secret net leaves untouched; the value is never read.
export const safeKey = (k: string) =>
  /^[A-Za-z0-9_-]{1,64}$/.test(k) && redactSecrets(k) === k ? k : "<invalid-key>";

/** How many unknown-field paths are ever logged, returned or put in an error. */
export const MAX_REPORTED_FIELDS = 50;
export function capPaths(paths: string[]): string[] {
  return paths.length <= MAX_REPORTED_FIELDS
    ? paths
    : [...paths.slice(0, MAX_REPORTED_FIELDS), `…and ${paths.length - MAX_REPORTED_FIELDS} more`];
}

/**
 * Paths of keys the schema does not know (`revision`-level and per persona),
 * names only. The schema strips them from stored state; this is how the
 * pipeline learns they were dropped.
 */
export function unknownFieldPaths(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  const out = Object.keys(o).filter((k) => !TOP_KEYS.has(k)).map(safeKey);
  if (Array.isArray(o.personas)) {
    o.personas.forEach((p, i) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return;
      const rec = p as Record<string, unknown>;
      const name = typeof rec.name === "string" && PERSONA_NAME_RE.test(rec.name) ? rec.name : `#${i}`;
      for (const k of Object.keys(rec)) if (!PERSONA_KEYS.has(k)) out.push(`persona.${name}.${safeKey(k)}`);
    });
  }
  return out;
}

export function parsePayload(raw: unknown, opts: { internalHosts?: readonly string[] } = {}): SyncPayload {
  const v = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  if (typeof v === "number" && Number.isInteger(v) && v > SUPPORTED_PAYLOAD_VERSION) {
    throw new PayloadError(
      `payload version ${v} is newer than this gateway supports (${SUPPORTED_PAYLOAD_VERSION}); upgrade the gateway before deploying it`,
    );
  }
  const r = payloadSchema.safeParse(raw);
  if (!r.success) throw new PayloadError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p: SyncPayload = {
    ...r.data,
    personas: r.data.personas.map(({ provider, kbSources, ...rest }) => {
      const parsed = parseProvider(rest.name, provider, opts.internalHosts ?? internalHostsFrom(process.env));
      const kb = parseKbSources(rest.name, kbSources);
      return { ...rest, ...(parsed ? { provider: parsed } : {}), ...(kb ? { kbSources: kb } : {}) };
    }),
  };
  const names = new Set<string>();
  const users = new Set<string>();
  for (const s of p.personas) {
    if (names.has(s.name)) throw new PayloadError(`duplicate persona name '${s.name}'`);
    names.add(s.name);
    if (s.name !== "default" && !s.slackUserId) throw new PayloadError(`persona '${s.name}' needs a slackUserId`);
    if (s.slackUserId) {
      if (users.has(s.slackUserId)) throw new PayloadError(`duplicate slackUserId on persona '${s.name}'`);
      users.add(s.slackUserId);
    }
  }
  return p;
}

/** Thrown for a well-formed placeholder whose name is outside the allowlist. */
export class DisallowedVarError extends PayloadError {
  constructor(readonly variable: string) {
    super(`variable \${${variable}} is not allowed — placeholder names must start with ${PERSONA_VAR_PREFIX}`);
  }
}

export { PERSONA_VAR_PREFIX };
const ALLOWED_VAR_RE = PERSONA_VAR_RE;
const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;
const INVALID_VAR_RE = /\$\{[^}]*\}/;

function resolveString(s: string, env: Record<string, string | undefined>): string {
  return s.replace(VAR_RE, (_, name: string) => {
    // Checked before the lookup: a disallowed name is never read from env.
    if (!ALLOWED_VAR_RE.test(name)) throw new DisallowedVarError(name);
    const v = env[name];
    // Empty counts as missing: storing an empty token is a silent outage.
    if (v === undefined || v === "") throw new UnresolvedVarError(name);
    return v;
  });
}

function resolveDeep(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === "string") return resolveString(v, env);
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, env));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(x, env)]));
  }
  return v;
}

function validateStringForInvalidPlaceholders(
  s: string,
  field: string,
  personaName: string,
): void {
  if (INVALID_VAR_RE.test(s)) {
    throw new PayloadError(
      `persona '${personaName}': ${field} contains an invalid placeholder — use \$\{UPPER_CASE_NAME\}`,
    );
  }
}

function validateDeepForInvalidPlaceholders(
  v: unknown,
  field: string,
  personaName: string,
): void {
  if (typeof v === "string") {
    validateStringForInvalidPlaceholders(v, field, personaName);
  } else if (Array.isArray(v)) {
    v.forEach((x) => validateDeepForInvalidPlaceholders(x, field, personaName));
  } else if (v && typeof v === "object") {
    Object.values(v).forEach((x) => validateDeepForInvalidPlaceholders(x, field, personaName));
  }
}

export function resolvePlaceholders(spec: PersonaSpec, env: Record<string, string | undefined>): PersonaSpec {
  const userToken = spec.userToken !== undefined ? resolveString(spec.userToken, env) : undefined;
  if (userToken !== undefined) {
    validateStringForInvalidPlaceholders(userToken, "userToken", spec.name);
  }

  const mcp = spec.mcp !== undefined ? (resolveDeep(spec.mcp, env) as Record<string, unknown>) : undefined;
  if (mcp !== undefined) {
    validateDeepForInvalidPlaceholders(mcp, "mcp", spec.name);
  }

  return {
    ...spec,
    ...(userToken !== undefined ? { userToken } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  };
}
