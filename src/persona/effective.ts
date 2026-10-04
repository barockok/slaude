/**
 * Effective persona state: the desired layer with the override layer laid over
 * it. This is the single merge; nothing else combines the two layers, so the
 * gateway, the runtime bundle and the panel cannot disagree about what is live.
 */
import { PROVIDER_FIELDS, type PersonaProvider } from "./sync/payload";
export type OverrideField = "soul" | "model" | "mcp";
export const OVERRIDE_FIELDS: readonly OverrideField[] = ["soul", "model", "mcp"];

export interface DesiredPersona {
  name: string;
  slackUserId: string | null;
  userToken: string | null;
  model: string | null;
  soulMd: string;
  soulJson: unknown;
  mcp: unknown;
  /** Provider credential REFERENCES (WS-A §4), never values. Desired layer
   *  only: not an override field, so a reference changes only through a sync.
   *  Absent and null both mean "this persona names no provider". */
  provider?: PersonaProvider | null;
  origin: "git" | "runtime";
  tombstonedAt: number | null;
}

export interface Override {
  field: OverrideField;
  /** For `soul`: `{ soulMd, soulJson }`, so text and structure never disagree. */
  value: unknown;
}

export type EffectivePersona = DesiredPersona & { overridden: OverrideField[] };

export function mergeEffective(desired: DesiredPersona, overrides: Override[]): EffectivePersona {
  const out: EffectivePersona = { ...desired, overridden: [] };
  for (const o of overrides) {
    if (!OVERRIDE_FIELDS.includes(o.field)) continue; // identity is not overridable
    if (o.field === "soul") {
      const v = o.value as { soulMd: string; soulJson: unknown };
      out.soulMd = v.soulMd;
      out.soulJson = v.soulJson;
    } else if (o.field === "model") {
      out.model = o.value as string;
    } else {
      out.mcp = o.value;
    }
    out.overridden.push(o.field);
  }
  return out;
}

/**
 * Whether a synced row would leave the stored persona unchanged. One
 * definition, shared by the real sync and the dry run, so their reports cannot
 * disagree.
 */
export function sameDesired(a: DesiredPersona, b: DesiredPersona): boolean {
  return a.slackUserId === b.slackUserId && a.userToken === b.userToken && a.model === b.model &&
    a.soulMd === b.soulMd && JSON.stringify(a.mcp) === JSON.stringify(b.mcp) &&
    canonicalProvider(a.provider) === canonicalProvider(b.provider) && a.tombstonedAt === null;
}

/** Key-order-independent form, so a row read back from JSONB compares equal. */
function canonicalProvider(p: PersonaProvider | null | undefined): string {
  if (!p) return "null";
  return JSON.stringify(PROVIDER_FIELDS.map((f) => p[f] ?? null));
}
