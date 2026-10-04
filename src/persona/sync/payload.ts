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

export const PERSONA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class PayloadError extends Error {
  readonly status = 422 as const;
}
export class UnresolvedVarError extends PayloadError {
  constructor(readonly variable: string) {
    super(`unresolved variable \${${variable}} — set it in the gateway's environment`);
  }
}

/**
 * The payload format this gateway understands. A payload with no `version` is
 * version 1. A newer one is refused rather than half-applied: its extra fields
 * might change what a persona means.
 */
export const SUPPORTED_PAYLOAD_VERSION = 1;

const personaSpec = z.object({
  name: z.string().regex(PERSONA_NAME_RE, "persona name must match ^[a-z0-9][a-z0-9-]{0,62}$"),
  slackUserId: z.string().min(1).optional(),
  userToken: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  soul: z.string(),
  mcp: z.record(z.unknown()).optional(),
});
export type PersonaSpec = z.infer<typeof personaSpec>;

const payloadSchema = z.object({
  version: z.number().int().min(1).default(1),
  revision: z.string().min(1),
  committedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "committedAt must be an ISO 8601 instant"),
  allowEmpty: z.boolean().default(false),
  personas: z.array(personaSpec),
});
export type SyncPayload = z.infer<typeof payloadSchema>;

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

export function parsePayload(raw: unknown): SyncPayload {
  const v = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  if (typeof v === "number" && Number.isInteger(v) && v > SUPPORTED_PAYLOAD_VERSION) {
    throw new PayloadError(
      `payload version ${v} is newer than this gateway supports (${SUPPORTED_PAYLOAD_VERSION}); upgrade the gateway before deploying it`,
    );
  }
  const r = payloadSchema.safeParse(raw);
  if (!r.success) throw new PayloadError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = r.data;
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
