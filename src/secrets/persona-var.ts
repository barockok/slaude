/**
 * The one rule for gateway-environment names a persona may read: `${PERSONA_*}`
 * placeholders in a sync payload and `env://PERSONA_*` references. No imports,
 * so both src/persona/sync/payload.ts and src/secrets can depend on it without
 * a cycle.
 */
export const PERSONA_VAR_PREFIX = "PERSONA_";
export const PERSONA_VAR_RE = /^PERSONA_[A-Z0-9_]+$/;
