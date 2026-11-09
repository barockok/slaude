/**
 * Effective persona state: the desired layer with the override layer laid over
 * it. This is the single merge; nothing else combines the two layers, so the
 * gateway, the runtime bundle and the panel cannot disagree about what is live.
 */
import { PROVIDER_FIELDS, type PersonaBackground, type PersonaDefinition, type PersonaProvider } from "./sync/payload";
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
  /** Provider credential REFERENCES (WS-A §4), never values. Desired layer
   *  only: not an override field, so a reference changes only through a sync.
   *  Absent and null both mean "this persona names no provider". */
  provider?: PersonaProvider | null;
  /** The `kb-*` sources this persona may read (WS-C §4.1). Absent and null
   *  both mean every installed KB; [] means none. Desired layer only, like
   *  provider: not an override field. */
  kbSources?: string[] | null;
  /** Background-learning budget and timezone. Absent and null both mean the
   *  defaults. Desired layer only, not an override field. */
  background?: PersonaBackground | null;
  /** Set when the persona comes from an agent.yaml; `soulJson` is then compiled
   *  from that file, never extracted. Null or absent: the older layout. Desired
   *  layer only, not an override field. */
  definition?: PersonaDefinition | null;
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
    (a.runsOn ?? null) === (b.runsOn ?? null) &&
    canonicalProvider(a.provider) === canonicalProvider(b.provider) &&
    JSON.stringify(a.kbSources ?? null) === JSON.stringify(b.kbSources ?? null) &&
    canonicalBackground(a.background) === canonicalBackground(b.background) &&
    sameDefinition(a, b) && a.tombstonedAt === null;
}

/**
 * A definition's soul is compiled, so its structure is part of what the sync
 * desires (an access change leaves the prose as it was). An extracted soul is
 * not compared: it follows the text, and extraction is not deterministic.
 */
function sameDefinition(a: DesiredPersona, b: DesiredPersona): boolean {
  if (!a.definition && !b.definition) return true;
  return stableJson(a.definition ?? null) === stableJson(b.definition ?? null) && stableJson(a.soulJson ?? null) === stableJson(b.soulJson ?? null);
}

/** JSON with sorted keys, so a row read back from JSONB compares equal. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
      : x);
}

function canonicalBackground(b: PersonaBackground | null | undefined): string {
  if (!b) return "null";
  return JSON.stringify([b.budgetUsd ?? null, b.timezone ?? null]);
}

/** Key-order-independent form, so a row read back from JSONB compares equal. */
function canonicalProvider(p: PersonaProvider | null | undefined): string {
  if (!p) return "null";
  return JSON.stringify(PROVIDER_FIELDS.map((f) => p[f] ?? null));
}
