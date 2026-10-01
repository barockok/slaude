/**
 * Effective persona state: the desired layer with the override layer laid over
 * it. This is the single merge; nothing else combines the two layers, so the
 * gateway, the runtime bundle and the panel cannot disagree about what is live.
 */
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
