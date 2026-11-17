import type { GateAction, ImplicitLevel } from "./types";

/**
 * The shadow line for an implicit-engagement decision. Never carries message
 * text. `tier` is the deterministic tier that settled it (0 to 3), `action`
 * what the engagement layer decided (the gate's "drop" is a "pass"), `actual`
 * what the gateway did.
 */
export function formatEngageLine(o: {
  key: string;
  level: ImplicitLevel;
  tier: 0 | 1 | 2 | 3;
  action: "run" | "pass";
  actual: GateAction | "pass";
}): string {
  const actual = o.actual === "drop" ? "pass" : o.actual;
  return `[gate] key=${o.key} implicit=${o.level} tier=${o.tier} action=${o.action} actual=${actual}`;
}

/** The engagement view of a gate action: only "run" runs; every other outcome is a pass. */
export function toEngageAction(a: GateAction | undefined): "run" | "pass" {
  return a === "run" ? "run" : "pass";
}
