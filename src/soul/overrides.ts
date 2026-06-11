import type { SoulData } from "./data";
import * as SO from "../db/soul-overrides";
import type { OverrideField, OverrideRow } from "../db/soul-overrides";

/** Command-noun → SoulData field. Single source for the slash + MCP surfaces. */
export const FIELD_ALIASES = {
  trust: "trustedChannels",
  allow: "allowedChannels",
  dm: "dmAllowedUsers",
  block: "blockedUsers",
} as const;
export type FieldAlias = keyof typeof FIELD_ALIASES;

const OVERRIDE_FIELDS: readonly OverrideField[] = Object.values(FIELD_ALIASES);

const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
const USER_RE = /^[UW][A-Z0-9]+$/;
const CHANNEL_FIELDS: ReadonlySet<OverrideField> = new Set(["trustedChannels", "allowedChannels"]);

/** Pure merge: effective[field] = (base ∪ adds) − removes. Base untouched. */
export function applyOverrides(base: SoulData, rows: OverrideRow[]): SoulData {
  if (rows.length === 0) return base;
  const out: SoulData = { ...base };
  for (const field of OVERRIDE_FIELDS) {
    const adds = rows.filter((r) => r.field === field && r.action === "add").map((r) => r.value);
    const removes = new Set(rows.filter((r) => r.field === field && r.action === "remove").map((r) => r.value));
    if (adds.length === 0 && removes.size === 0) continue;
    out[field] = [...new Set([...base[field], ...adds])].filter((v) => !removes.has(v));
  }
  return out;
}

/** Strip <#C…|name> / <@U…> wrappers down to the raw id. Raw ids pass through. */
export function normalizeId(raw: string): string {
  const m = raw.trim().match(/^<[#@]?([A-Z0-9]+)(\|[^>]*)?>$/);
  return m ? m[1]! : raw.trim();
}

export type MutateResult =
  | { ok: true; field: OverrideField; value: string }
  | { ok: false; reason: string };

/** Validated write. Authority (manager check) is the CALLER's job — this layer
 *  enforces id shape + the self-lockout guard, and is shared by slash + MCP. */
export function mutateOverride(
  i: { field: FieldAlias | OverrideField; action: "add" | "remove"; value: string; by: string },
  opts: { managerId?: string },
): MutateResult {
  const field: OverrideField =
    (FIELD_ALIASES as Record<string, OverrideField>)[i.field] ?? (i.field as OverrideField);
  if (!OVERRIDE_FIELDS.includes(field)) return { ok: false, reason: `unknown field \`${i.field}\`` };
  const value = normalizeId(i.value);
  const isChannel = CHANNEL_FIELDS.has(field);
  if (!(isChannel ? CHANNEL_RE : USER_RE).test(value)) {
    return { ok: false, reason: `\`${value}\` is not a valid ${isChannel ? "channel (C…/G…/D…)" : "user (U…/W…)"} id` };
  }
  if (field === "blockedUsers" && i.action === "add" && opts.managerId && value === opts.managerId) {
    return { ok: false, reason: "refusing to block the manager (self-lockout guard)" };
  }
  SO.upsert({ field, value, action: i.action, created_by: i.by });
  console.log(`[soul-override] field=${field} value=${value} action=${i.action} by=${i.by}`);
  return { ok: true, field, value };
}
