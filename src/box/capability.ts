/**
 * The node capabilities of boxes (box spec, "Sandbox tiers", "Ordering").
 *
 * A node that offers a sandbox advertises `box/1` and its tier on its
 * heartbeat and on every bundle fetch; dispatch sends a boxed persona's turns
 * only to a node that advertises what the box requires (the existing
 * capability gate).
 *
 * The gate compares capability strings exactly, and tiers are ordered
 * (`none < bwrap < gvisor`: a box states the WEAKEST tier it accepts). So a
 * node advertises the capability of every sandbox tier at or below its own: a
 * `gvisor` node also advertises `box-tier/bwrap`, and a box that accepts
 * `bwrap` is served by it. A node on tier `none` advertises nothing here.
 */
import { BOX_TIERS, tierSatisfies, type BoxTier } from "./policy";

/** The node capability that says a node runs sessions in sandboxes built from a box. */
export const BOX_CAPABILITY = "box/1";

/** The node capability that says a node offers at least this sandbox tier. */
export function boxTierCapability(tier: Exclude<BoxTier, "none">): string {
  return `box-tier/${tier}`;
}

/** What a node offering `tier` advertises: nothing for `none`. */
export function nodeBoxCapabilities(tier: BoxTier): string[] {
  if (tier === "none") return [];
  const tiers = BOX_TIERS.filter((t): t is Exclude<BoxTier, "none"> => t !== "none" && tierSatisfies(tier, t));
  return [BOX_CAPABILITY, ...tiers.map(boxTierCapability)];
}

/** What a turn of a box whose weakest accepted tier is `tier` requires of its node: nothing for `none`. */
export function requiredBoxCapabilities(tier: BoxTier): string[] {
  return tier === "none" ? [] : [BOX_CAPABILITY, boxTierCapability(tier)];
}
