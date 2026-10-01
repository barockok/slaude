/**
 * The sync payload a pipeline POSTs, and the one place placeholders resolve.
 *
 * Resolution touches userToken and the mcp object only. Soul text is content:
 * a soul can document a template and legitimately contain `${...}`, and
 * resolving it would silently rewrite what the agent says.
 */
import { z } from "zod";

export const PERSONA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class PayloadError extends Error {
  readonly status = 422 as const;
}
export class UnresolvedVarError extends PayloadError {
  constructor(readonly variable: string) {
    super(`unresolved variable \${${variable}} — set it in the gateway's environment`);
  }
}

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
  revision: z.string().min(1),
  committedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "committedAt must be an ISO 8601 instant"),
  allowEmpty: z.boolean().default(false),
  personas: z.array(personaSpec),
});
export type SyncPayload = z.infer<typeof payloadSchema>;

export function parsePayload(raw: unknown): SyncPayload {
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

const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

function resolveString(s: string, env: Record<string, string | undefined>): string {
  return s.replace(VAR_RE, (_, name: string) => {
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

export function resolvePlaceholders(spec: PersonaSpec, env: Record<string, string | undefined>): PersonaSpec {
  return {
    ...spec,
    ...(spec.userToken !== undefined ? { userToken: resolveString(spec.userToken, env) } : {}),
    ...(spec.mcp !== undefined ? { mcp: resolveDeep(spec.mcp, env) as Record<string, unknown> } : {}),
  };
}
