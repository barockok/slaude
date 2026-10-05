/**
 * The security switches: environment variables that open or close a door
 * (a legacy credential, a tokenless call, a node holding gateway secrets, a
 * /deploy payload with unknown fields).
 *
 * One spelling rule for every on/off switch: 1|true|yes|on and 0|false|no|off,
 * any case, surrounding space ignored; empty or unset is the documented
 * default. Any other value is a typo, and a typo in a security switch must not
 * silently pick a side: the role that reads the switch refuses to boot, naming
 * the variable (securitySwitchViolations). Readers called at runtime fail
 * closed on such a value, in case a check was skipped.
 */

const ON = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["0", "false", "no", "off"]);

/** true / false for a recognised value, `undefined` when unset or empty,
 *  `null` for anything else. */
export function parseFlag(raw: string | undefined): boolean | null | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return undefined;
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  return null;
}

/** The switch's value: its default when unset, `invalid` for an unknown value
 *  (the caller picks the closed side). */
export function flag(raw: string | undefined, dflt: boolean, invalid: boolean): boolean {
  const p = parseFlag(raw);
  return p === undefined ? dflt : p === null ? invalid : p;
}

export type NodeBootCheckMode = "warn" | "refuse";

/** SLAUDE_NODE_BOOT_CHECK: refuse (default) | warn. `null` for an unknown value. */
export function parseBootCheckMode(raw: string | undefined): NodeBootCheckMode | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "refuse") return "refuse";
  if (v === "warn") return "warn";
  return null;
}

/** On/off switches read by a gateway (and mono, which mounts /v1 and /deploy). */
export const GATEWAY_FLAG_SWITCHES = [
  "SLAUDE_NODE_LEGACY",
  "SLAUDE_NODE_ALLOW_TOKENLESS_PENDING",
  "SLAUDE_DEPLOY_STRICT",
] as const;

/** On/off switches read by a node. */
export const NODE_FLAG_SWITCHES = ["SLAUDE_NODE_ALLOW_GATEWAY_SECRETS"] as const;

const SPELLINGS = "1|true|yes|on or 0|false|no|off";

/** Boot refusals for the switches `role` reads: one line per bad variable,
 *  naming it. The value is quoted only as the operator wrote it in a switch,
 *  never a secret. */
export function securitySwitchViolations(role: "mono" | "gateway" | "node", e: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const names = role === "node" ? NODE_FLAG_SWITCHES : GATEWAY_FLAG_SWITCHES;
  for (const name of names) {
    if (parseFlag(e[name]) === null) out.push(`${name} must be ${SPELLINGS} (got '${(e[name] ?? "").trim()}')`);
  }
  if (role === "node" && parseBootCheckMode(e.SLAUDE_NODE_BOOT_CHECK) === null) {
    out.push(`SLAUDE_NODE_BOOT_CHECK must be refuse or warn (got '${(e.SLAUDE_NODE_BOOT_CHECK ?? "").trim()}')`);
  }
  return out;
}
