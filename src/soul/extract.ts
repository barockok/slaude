import { env } from "../config/env";
import { SoulDataSchema, type SoulData, type ApproverEntry } from "./data";
import { applyOverrides } from "./overrides";
import { resolveSoulMandate } from "./mandate-scope";
import * as SoulOverrides from "../db/soul-overrides";

/**
 * The default persona's structure, installed at boot from its agent.yaml (or its
 * managed row) with {@link setSoulData}. Nothing reads it out of prose: before
 * it is installed, and for a home with no definition, it is empty, so nobody
 * is admitted and nobody may approve.
 */
let memo: SoulData | null = null;
export function setSoulData(d: SoulData) { memo = d; }
/** Test helper: drop the installed structure. */
export function __resetSoulDataMemo() { memo = null; }
/** Un-overlaid default structure. Use for provenance rendering (/soul list); gates must use soulData(). */
export function soulDataBase(): SoulData {
  return memo ?? SoulDataSchema.parse({});
}

/** Effective soul: (SOUL.md ∪ runtime adds) − runtime removes. The overlay is
 *  read per call, so a manager override is live on the next inbound message
 *  in every session — no reload. See src/soul/overrides.ts. */
export function soulData(): SoulData {
  const base = soulDataBase();
  // The overlay lives in the database, which a node never opens. A node does
  // not apply runtime overrides: the gateway enforces the lists they edit. Only
  // the tier-3 default bundle's soulJson (read here on the gateway) carries
  // them, and only channelMandateBlock reads that.
  if (env.role() === "node") return base;
  try {
    return applyOverrides(base, SoulOverrides.listSync());
  } catch {
    return base; // overlay must never take the gates down
  }
}

/**
 * Effective soul for a specific Slack channel. Starts from the global
 * {@link soulData} (runtime overlays preserved), then applies the matching
 * `## Channel` block: mandate replaced when the override sets one, approvers
 * replaced when the override lists ≥1. No channel / no match → global view.
 *
 * Replace semantics (operator choice): inside an overridden channel the
 * channel approver list is the *only* approver source for the approval gate
 * and approver-based admin auth. manager/backup authority is a separate check
 * and is never affected. See docs/superpowers/specs/2026-06-20-channel-soul-overrides-design.md.
 *
 * Always returns a usable SoulData — any failure falls back to the global
 * view so the gates never break.
 */
/**
 * Guarantee the manager (and backup manager) stay eligible approvers even when
 * a channel override replaces the approver set. Without this, a channel block
 * that lists only e.g. the DBA would lock the operator out of the approval gate
 * in that channel. Manager/backup are appended as catchalls (always eligible)
 * unless already present in the override list.
 */
export function withManagerApprover(approvers: ApproverEntry[], base: SoulData): ApproverEntry[] {
  const out = [...approvers];
  const have = new Set(out.map((a) => a.userId));
  for (const id of [base.manager?.userId, base.backupManager?.userId]) {
    if (id && !have.has(id)) {
      out.push({ userId: id, scope: "anything", catchall: true });
      have.add(id);
    }
  }
  return out;
}

/** A channel block's own trimmed mandate; null when it has no block or no mandate (it inherits the global one). */
export function channelMandate(soul: SoulData, channelId: string): string | null {
  const m = soul.channelOverrides.find((c) => c.channel === channelId)?.mandate?.trim();
  return m || null;
}

/**
 * `base` narrowed to one channel: the mandate from the resolver (the most
 * specific sub-mandate, by its mode), approvers from the channel's own block.
 * Nothing applying returns `base` itself.
 */
export function soulForChannel(base: SoulData, channelId: string): SoulData {
  const ov = base.channelOverrides.find((c) => c.channel === channelId);
  const resolved = resolveSoulMandate(base, channelId, base);
  if (!ov && !resolved.applied) return base;
  return {
    ...base,
    mandate: resolved.applied ? resolved.text : base.mandate,
    approvers: ov?.approvers.length ? withManagerApprover(ov.approvers, base) : base.approvers,
  };
}

export function effectiveSoulForChannel(channelId?: string): SoulData {
  const base = soulData();
  if (!channelId) return base;
  try {
    return soulForChannel(base, channelId);
  } catch {
    return base;
  }
}
