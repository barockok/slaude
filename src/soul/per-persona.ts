import { SoulDataSchema, type ChannelOverride, type SoulData } from "./data";
import { soulData, soulForChannel, withManagerApprover } from "./extract";
import { getPersonaRegistry } from "../persona/registry";

/**
 * Structured soul per persona. `soulData()` and `effectiveSoulForChannel()` are
 * process-wide views of the default soul; these take a persona name.
 *
 *  - default persona (or none): `soulData()`, runtime `soul_overrides` included
 *    (they apply to the default soul only).
 *  - managed named persona: its `personas.soul_json`, carried in the registry
 *    snapshot, so the read is synchronous and never touches the database.
 *  - filesystem persona, sqlite, or a soul_json that does not validate: no
 *    structured soul of its own (phase 1).
 *
 * The ACL fields fall back field by field to the default soul (see
 * {@link withAclFallback}), so with no stored grants a named persona admits
 * exactly what it admits today.
 */
export function soulDataFor(persona?: string | null): SoulData {
  const def = soulData();
  if (!persona || persona === "default") return def;
  return withAclFallback(ownSoul(persona), def);
}

/** Personas whose soul_json failed to parse, warned once each per process. */
const warnedUnparsed = new Set<string>();

/** Parsed soul_json by the registry snapshot's own value: a new snapshot (a
 *  sync) carries a new object, so the cache never outlives the registry. */
const parsedSouls = new WeakMap<object, SoulData | null>();

function parseSoul(raw: unknown): SoulData | null {
  if (typeof raw !== "object" || raw === null) {
    const parsed = SoulDataSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  if (parsedSouls.has(raw)) return parsedSouls.get(raw)!;
  const parsed = SoulDataSchema.safeParse(raw);
  const out = parsed.success ? parsed.data : null;
  parsedSouls.set(raw, out);
  return out;
}

function ownSoul(persona: string): SoulData | null {
  try {
    const raw = getPersonaRegistry().lookupByName(persona)?.soulJson;
    if (raw == null) return null;
    const parsed = parseSoul(raw);
    if (parsed) return parsed;
    if (!warnedUnparsed.has(persona)) {
      warnedUnparsed.add(persona);
      console.warn(`[soul] persona=${persona} structured soul does not parse; using the default soul's access fields`);
    }
    return null;
  } catch {
    return null;
  }
}

const EMPTY: SoulData = SoulDataSchema.parse({});

/**
 * Fallback by unit, each taken whole from the persona when it names any part
 * of it, else whole from the default:
 *  - managers: {manager, backup manager};
 *  - channels: {trusted channels, allowed channels};
 *  - DM allowlist; blocked users (separate fields);
 *  - approvers: one field covering the global list and every channel block's
 *    list. A persona that names none inherits the default's global approvers
 *    and its channel blocks' approvers (never the default's mandates).
 * Everything else (identity, mandate, values, redaction, timeout) stays the
 * persona's own. `own` null (no structured soul) inherits every ACL unit.
 */
export function withAclFallback(own: SoulData | null, def: SoulData): SoulData {
  const p = own ?? EMPTY;
  const list = <T>(mine: T[], theirs: T[]): T[] => (mine.length ? mine : theirs);
  const ownsManagers = !!(p.manager.userId || p.backupManager.userId);
  const ownsChannels = p.trustedChannels.length > 0 || p.allowedChannels.length > 0;
  const ownsApprovers = p.approvers.length > 0 || p.channelOverrides.some((c) => c.approvers.length > 0);
  const managers = ownsManagers ? p : def;
  const channels = ownsChannels ? p : def;
  return {
    ...p,
    manager: managers.manager,
    backupManager: managers.backupManager,
    trustedChannels: channels.trustedChannels,
    allowedChannels: channels.allowedChannels,
    dmAllowedUsers: list(p.dmAllowedUsers, def.dmAllowedUsers),
    blockedUsers: list(p.blockedUsers, def.blockedUsers),
    approvers: ownsApprovers ? p.approvers : def.approvers,
    channelOverrides: ownsApprovers ? p.channelOverrides : inheritChannelApprovers(p.channelOverrides, def.channelOverrides),
  };
}

/** The persona's own channel blocks with the default's channel approvers laid in
 *  (a default block the persona lacks comes over with approvers only). */
function inheritChannelApprovers(mine: ChannelOverride[], theirs: ChannelOverride[]): ChannelOverride[] {
  const out = mine.map((c) => ({ ...c }));
  for (const d of theirs) {
    if (!d.approvers.length) continue;
    const hit = out.find((c) => c.channel === d.channel);
    if (hit) hit.approvers = d.approvers;
    else out.push({ channel: d.channel, approvers: d.approvers });
  }
  return out;
}

/**
 * {@link soulDataFor} narrowed to a channel, with the semantics of
 * `effectiveSoulForChannel`: the mandate from the resolver (mode and boundary),
 * and a channel block's approvers (when it lists any) replace the global approvers, with the
 * persona's manager and backup always appended.
 */
export function effectiveSoulForChannelFor(persona: string | null | undefined, channelId?: string | null): SoulData {
  const base = soulDataFor(persona);
  if (!channelId) return base;
  return soulForChannel(base, channelId);
}

/** Channel id -> that channel's effective approver ids, for every channel block
 *  that replaces the global approvers (manager and backup appended). */
export function channelApproversOf(soul: SoulData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of soul.channelOverrides) {
    if (c.approvers.length) out.set(c.channel, withManagerApprover(c.approvers, soul).map((a) => a.userId));
  }
  return out;
}

/**
 * The redaction patterns for what an agent posts: the default persona's,
 * plus the agent's own, deduplicated. A union, never a replacement: an agent's
 * soul can only add redaction. Read per post, so a soul change applies at once.
 */
export function redactPatternsFor(persona?: string | null): string[] {
  const def = soulData().redactPatterns;
  if (!persona || persona === "default") return [...new Set(def)];
  let own: string[] = [];
  try {
    own = soulDataFor(persona).redactPatterns;
  } catch {
    own = [];
  }
  return [...new Set([...def, ...own])];
}

/**
 * An agent's approval timeout in seconds: its own soul's when it sets one,
 * else the default persona's; 0 when neither does (the caller's default applies).
 */
export function approvalTimeoutFor(persona?: string | null): number {
  const def = soulData().approvalTimeoutSeconds;
  if (!persona || persona === "default") return def;
  try {
    const own = soulDataFor(persona).approvalTimeoutSeconds;
    return own > 0 ? own : def;
  } catch {
    return def;
  }
}
