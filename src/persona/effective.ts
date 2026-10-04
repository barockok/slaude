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
  /** The node label this persona runs on (node labels spec §4.5); null or
   *  absent = `default`. Desired layer only: no override can set it. */
  runsOn?: string | null;
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
    (a.runsOn ?? null) === (b.runsOn ?? null) && a.tombstonedAt === null;
}
