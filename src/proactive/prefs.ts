/**
 * A person's ping preferences (spec §10.4, §8.2): fields on their `profile`
 * page, written only from their own words (memory skill), read by code so
 * the restraint rules (restraint.ts) can enforce them.
 *
 *   pings        `yes` opts in to proactive DMs; anything else is no
 *   topics       comma-separated topics they want pings about
 *   mutes        comma-separated muted topics, or `all`
 *   quiet_hours  `HH:MM-HH:MM`, in `timezone`
 *   timezone     IANA; absent = the persona's
 *
 * Read from that person's own profile source only. Any failure reads as
 * NO_PREFS: no opt-in (the safe direction), and no mute or quiet hours (a
 * profile that cannot be read cannot be honoured, and the SOUL's own rules
 * still apply).
 */
import { isValidTimeZone } from "../config/timezone";
import { readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, type BrainOpCall } from "../knowledge/memory-trail";
import { speakerProfileSource } from "../knowledge/scope";
import { parseWindow, type QuietHours } from "../soul/proactive";

export interface PingPrefs {
  pings: boolean;
  topics: string[];
  mutes: string[] | "all";
  quietHours: QuietHours | null;
  timeZone: string | null;
}

export const NO_PREFS: PingPrefs = Object.freeze({ pings: false, topics: [], mutes: [], quietHours: null, timeZone: null }) as PingPrefs;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
const list = (s: string | undefined): string[] => (s ?? "").split(",").map(norm).filter(Boolean);

export function prefsFromProfile(meta: Record<string, string>): PingPrefs {
  const mutes = norm(meta.mutes ?? "") === "all" ? ("all" as const) : list(meta.mutes);
  const tz = meta.timezone?.trim();
  return {
    pings: norm(meta.pings ?? "") === "yes",
    topics: list(meta.topics),
    mutes,
    quietHours: meta.quiet_hours ? parseWindow(meta.quiet_hours) : null,
    timeZone: tz && isValidTimeZone(tz) ? tz : null,
  };
}

/** True when the person muted this topic, or everything. */
export function muted(p: PingPrefs, topic: string): boolean {
  if (p.mutes === "all") return true;
  const t = norm(topic);
  return t !== "" && p.mutes.includes(t);
}

/** True when the person opted in to pings and lists this topic. */
export function optedIn(p: PingPrefs, topic: string): boolean {
  const t = norm(topic);
  return p.pings && t !== "" && p.topics.includes(t);
}

export async function readPingPrefs(call: BrainOpCall, teamId: string | null, userId: string): Promise<PingPrefs> {
  const source = speakerProfileSource(teamId, userId);
  if (source === null) return { ...NO_PREFS };
  try {
    const rec = readPageRecord(await getPageOrNull(call, "profile", { clientId: userId, sourceId: source, allowedSources: [source] }));
    if (!rec || rec.superseded) return { ...NO_PREFS };
    return prefsFromProfile(rec.meta);
  } catch (e) {
    console.warn(`[proactive] could not read ping preferences for ${userId}: ${e instanceof Error ? e.message : String(e)}`);
    return { ...NO_PREFS };
  }
}
