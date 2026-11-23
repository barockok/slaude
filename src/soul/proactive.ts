/**
 * The proactiveness switch (spec §10.2; invariant 3): `### Proactive` inside a
 * `## Channel <#C…>` block, and a `## Proactive` section for the round, in
 * either direction.
 *
 * Proactive is defined per channel. Turning it on makes that channel a channel
 * session with wakes:
 *
 *   ## Channel <#C…>
 *   ### Proactive
 *   - Enabled: yes           # one long-lived session here, and the agent works on its own in it
 *
 * A channel can have the session without the wakes:
 *
 *   ## Channel <#C…>
 *   ### Session
 *   - Mode: channel          # anything else is logged and reads as off: no session, no wakes
 *
 * `## Proactive` carries only limits that every channel inherits unless it sets its
 * own. It switches nothing on: `Enabled`, `Watch` and `Read` there have no effect
 * (a warning names them), because proactive is per channel and an agent-level round
 * or channel allowlist would reach across the boundary between channels:
 *   - Max per day: 6         # posts per recipient per day (either section)
 *   - Quiet hours: 21:00–08:00
 *
 * Still honoured so a soul can narrow things, never needed to turn anything on:
 *   - Wake: no               # this agent never wakes; its channel sessions stay (global only)
 *   - Highest: ask           # lower the ceiling: ignore | inform | ask (default act)
 *   - Cooldown: 4 hours      # minimum gap between posts to one recipient
 *   - Max per person per day # the old name of Max per day
 *
 * Parsed here, deterministically, from the persona's SOUL text. Never through
 * the LLM structured extraction (a mis-extraction must never turn it on), never
 * through runtime overrides (src/soul/overrides.ts), never by a command. Only
 * the SOUL can raise it; a person's profile can only lower it (restraint.ts).
 */
import type { MandateMode, ScopeMandate } from "./data";
import { parseModeLine } from "./mandate-scope";
import { createHash } from "node:crypto";
import { personaSoulText } from "../persona/soul-source";
import { parseLevel, type Level } from "../proactive/levels";

export interface QuietHours {
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

export interface ProactiveConfig {
  quietHours: QuietHours | null;
  maxPerPersonPerDay: number;
  cooldownHours: number;
  /** The ceiling no learned reaction may raise the level past. */
  highest: Level;
  /** False when the soul says `Wake: no`: this agent never wakes in any channel (global only). */
  wake: boolean;
  /** Keys written under the global `## Proactive` that no longer do anything (`enabled`, `watch`, `read`), once each. */
  ignoredGlobal: string[];
  /** Channel id → that channel's own `### Proactive` `Enabled`. */
  channels: Record<string, boolean>;
  /** Channel id → that channel's own `### Proactive` `Highest`. */
  channelHighest: Record<string, Level>;
  /** Channel id → that channel's own `### Proactive` `Cooldown`, in hours. */
  channelCooldownHours: Record<string, number>;
  /** Channel id → that channel's own `### Proactive` `Max per day`. */
  channelMaxPerDay: Record<string, number>;
  /**
   * Channel id → that channel's own written `### Session` `Mode`, only when it is valid.
   * What the soul says, for export and the definition view: whether a channel has
   * a session is {@link hasChannelSession}, which also counts `Enabled: yes`.
   */
  sessions: Record<string, "channel">;
  /** Channels with a `### Session` `Mode` that is not a known mode, once each; never in `sessions`. These read as off. */
  invalidSessions: string[];
}

/** The resolved switch for one audience: the global limits, and `enabled` only for a channel whose own `### Proactive` says so. */
export type ResolvedProactive = Omit<ProactiveConfig, "wake" | "ignoredGlobal" | "channels" | "channelHighest" | "channelCooldownHours" | "channelMaxPerDay" | "sessions" | "invalidSessions"> & { enabled: boolean };

export const DEFAULT_MAX_PER_PERSON_PER_DAY = 6;
export const DEFAULT_COOLDOWN_HOURS = 1;

const DISABLED: ResolvedProactive = {
  enabled: false,
  quietHours: null,
  maxPerPersonPerDay: DEFAULT_MAX_PER_PERSON_PER_DAY,
  cooldownHours: DEFAULT_COOLDOWN_HOURS,
  highest: "inform",
};

/** `HH:MM` → minutes since midnight, or null. */
export function parseClock(s: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** `HH:MM–HH:MM` (en dash, em dash or hyphen) → a window, or null. */
export function parseWindow(s: string): QuietHours | null {
  const parts = s.split(/\s*[–—-]\s*/);
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0]!);
  const end = parseClock(parts[1]!);
  return start === null || end === null ? null : { start, end };
}

/** True when `minutes` falls in the window; a window whose end is before its start wraps midnight. */
export function inWindow(minutes: number, w: QuietHours): boolean {
  if (w.start === w.end) return false;
  return w.start < w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end;
}

const CHANNEL_ID = /^[CGD][A-Z0-9]+$/;

/** The channel id of a `## Channel …` heading, or null for a placeholder. */
export function channelOf(heading: string): string | null {
  const m = /^##\s+channel\s+(?:<#([A-Za-z0-9]+)(?:\|[^>]*)?>|([A-Za-z0-9]+))/i.exec(heading.trim());
  const id = m ? (m[1] ?? m[2])! : "";
  return CHANNEL_ID.test(id) ? id : null;
}

/** A line that opens or closes a code fence; a soul parser reads nothing inside one. */
export const isCodeFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);

/** Whether `text` ends inside a code fence, so anything appended to it would not be read. */
export function endsInOpenFence(text: string): boolean {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) if (isCodeFence(line)) fenced = !fenced;
  return fenced;
}

/** One `- Key: value` line (also `*`), comment after `#` dropped. */
function keyValue(line: string): [string, string] | null {
  const m = /^\s*[-*]\s*([^:]+):\s*(.*)$/.exec(line);
  if (!m) return null;
  return [m[1]!.trim().toLowerCase(), m[2]!.replace(/\s+#.*$/, "").trim()];
}

/** A cap from a SOUL line: a positive whole number, or null. */
function parseCap(value: string): number | null {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A cooldown from a SOUL line, in hours, or null. */
function parseCooldown(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(?:h|hours?)?$/i.exec(value);
  return m ? Number(m[1]) : null;
}

export function parseProactive(text: string): ProactiveConfig {
  const out: ProactiveConfig = {
    quietHours: null,
    maxPerPersonPerDay: DEFAULT_MAX_PER_PERSON_PER_DAY,
    cooldownHours: DEFAULT_COOLDOWN_HOURS,
    // Where proactiveness is on, the mandate is the authority: the ceiling only narrows.
    highest: "act",
    wake: true,
    ignoredGlobal: [],
    channels: {},
    channelHighest: {},
    channelCooldownHours: {},
    channelMaxPerDay: {},
    sessions: {},
    invalidSessions: [],
  };
  // Where we are: the global section, a channel's Proactive or Session subsection, or elsewhere.
  let where: { kind: "global" } | { kind: "channel"; id: string; sub: "proactive" | "session" | null } | null = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (isCodeFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#\s/.test(line)) {
      where = null;
      continue;
    }
    if (/^##\s/.test(line)) {
      if (/^##\s+proactive\s*$/i.test(line.trim())) where = { kind: "global" };
      else {
        const id = /^##\s+channel\b/i.test(line) ? channelOf(line) : null;
        where = id ? { kind: "channel", id, sub: null } : null;
      }
      continue;
    }
    if (/^###\s/.test(line)) {
      if (where?.kind === "channel") {
        const h = line.trim();
        where.sub = /^###\s+proactive\s*$/i.test(h) ? "proactive" : /^###\s+session\s*$/i.test(h) ? "session" : null;
      } else where = null;
      continue;
    }
    if (!where) continue;
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (where.kind === "channel") {
      if (where.sub === "session") {
        if (key === "mode") {
          // One invalid line turns the mode off for the channel, whatever else the soul says for it.
          if (value.toLowerCase() !== "channel") {
            delete out.sessions[where.id];
            if (!out.invalidSessions.includes(where.id)) out.invalidSessions.push(where.id);
          } else if (!out.invalidSessions.includes(where.id)) out.sessions[where.id] = "channel";
        }
        continue;
      }
      if (where.sub !== "proactive") continue;
      if (key === "enabled") out.channels[where.id] = value.toLowerCase() === "yes";
      else if (key === "highest") {
        const l = parseLevel(value);
        if (l) out.channelHighest[where.id] = l;
      } else if (key === "cooldown") {
        const h = parseCooldown(value);
        if (h !== null) out.channelCooldownHours[where.id] = h;
      } else if (key === "max per day" || key === "max per person per day") {
        const n = parseCap(value);
        if (n !== null) out.channelMaxPerDay[where.id] = n;
      }
      continue;
    }
    if (key === "enabled" || key === "read" || key === "watch") {
      if (!out.ignoredGlobal.includes(key)) out.ignoredGlobal.push(key);
    } else if (key === "wake") out.wake = value.toLowerCase() === "yes";
    else if (key === "highest") out.highest = parseLevel(value) ?? out.highest;
    else if (key === "quiet hours") out.quietHours = parseWindow(value);
    else if (key === "max per person per day" || key === "max per day") {
      const n = parseCap(value);
      if (n !== null) out.maxPerPersonPerDay = n;
    } else if (key === "cooldown") {
      const h = parseCooldown(value);
      if (h !== null) out.cooldownHours = h;
    }
  }
  return out;
}

let soulSource: (personaId: string | undefined) => string = personaSoulText;

/** Test seam: replace where soul text comes from (null restores personaSoulText). */
export function __setProactiveSoulSource(f: ((personaId: string | undefined) => string) | null): void {
  soulSource = f ?? personaSoulText;
  memo.clear();
}

/** Parsed configs by soul text hash: the soul changes rarely, the check runs per post. */
const memo = new Map<string, ProactiveConfig>();

function configFor(personaId: string): ProactiveConfig | null {
  try {
    const text = soulSource(personaId === "default" ? undefined : personaId);
    const key = createHash("sha256").update(text).digest("hex");
    let c = memo.get(key);
    if (!c) {
      c = parseProactive(text);
      for (const id of c.invalidSessions) console.warn(`[proactive] persona=${personaId} channel=${id}: unknown session Mode, so this channel has no channel session and no wakes`);
      if (c.ignoredGlobal.length) console.warn(`[proactive] persona=${personaId}: a global ## Proactive ${c.ignoredGlobal.map((k) => k[0]!.toUpperCase() + k.slice(1)).join(", ")} has no effect. Proactive is per channel: set ### Proactive under a ## Channel block.`);
      for (const id of Object.keys(c.channels)) {
        // Only the channels this release turned into sessions: a written Mode always ignored them.
        if (!c.channels[id] || c.sessions[id] || !hasChannelSession(c, id)) continue;
        if (id in c.channelHighest || id in c.channelCooldownHours || id in c.channelMaxPerDay) console.warn(`[proactive] persona=${personaId} channel=${id}: Highest, Cooldown and Max per day have no effect in a channel session`);
      }
      if (memo.size > 64) memo.clear();
      memo.set(key, c);
    }
    return c;
  } catch {
    return null;
  }
}

/** Whether a parsed soul gives this channel one long-lived session: `Mode: channel`, or `Enabled: yes` (proactive means a channel session). An invalid `Mode` is off. */
function hasChannelSession(c: ProactiveConfig, channelId: string): boolean {
  if (c.invalidSessions.includes(channelId)) return false;
  return c.sessions[channelId] === "channel" || c.channels[channelId] === true;
}

/**
 * The switch for a persona, for one channel when given: that channel's own
 * `### Proactive` for `enabled` (off without one), its own limits when it sets
 * them, else the global limits. Without a channel it is never enabled. Any failure
 * reads as disabled.
 */
export function proactiveFor(personaId: string, channelId?: string): ResolvedProactive {
  const c = configFor(personaId);
  if (!c) return { ...DISABLED };
  const { wake: _wake, ignoredGlobal: _ignored, channels, channelHighest, channelCooldownHours, channelMaxPerDay, sessions: _sessions, invalidSessions, ...global } = c;
  // Nothing is on at the agent level: only a channel's own `Enabled: yes` turns proactiveness on.
  if (channelId === undefined) return { ...global, enabled: false };
  const resolved: ResolvedProactive = {
    ...global,
    // An invalid Mode reads as off, whatever the rest of the channel's block says.
    enabled: invalidSessions.includes(channelId) ? false : channels[channelId] ?? false,
    highest: channelHighest[channelId] ?? global.highest,
    cooldownHours: channelCooldownHours[channelId] ?? global.cooldownHours,
    maxPerPersonPerDay: channelMaxPerDay[channelId] ?? global.maxPerPersonPerDay,
  };
  // A channel session has no cap, cooldown or ceiling; `enabled` and quiet hours still apply.
  if (hasChannelSession(c, channelId)) {
    return { ...resolved, highest: "act", cooldownHours: 0, maxPerPersonPerDay: Number.MAX_SAFE_INTEGER };
  }
  return resolved;
}

/** Whether this agent runs one long-lived session in this channel. Any failure reads as off. */
export function channelSessionOn(personaId: string, channelId: string): boolean {
  const c = configFor(personaId);
  return !!c && hasChannelSession(c, channelId);
}

/** The channels this agent wakes in, each in its channel session. `Wake: no` wakes none of them. */
export function channelSessionWakes(personaId: string): string[] {
  const c = configFor(personaId);
  if (!c?.wake) return [];
  return Object.entries(c.channels).filter(([id, on]) => on && hasChannelSession(c, id)).map(([id]) => id).sort();
}

/** Whether `Wake: no` is what keeps this persona's proactive channels from waking. */
export function wakesSwitchedOff(personaId: string): boolean {
  const c = configFor(personaId);
  return !!c && !c.wake && Object.entries(c.channels).some(([id, on]) => on && hasChannelSession(c, id));
}

/** The channels this persona may read with read_channel: only where it works on its own. */
export function proactiveRead(personaId: string): string[] {
  const c = configFor(personaId);
  if (!c) return [];
  // Not channelSessionWakes: `Wake: no` stops the wakes, not the reading.
  return Object.entries(c.channels).filter(([id, on]) => on && hasChannelSession(c, id)).map(([id]) => id);
}

/**
 * The manager's user id from the SOUL's `## Reporting` section, parsed here so a
 * persona's manager does not depend on the LLM extraction having run for this
 * exact soul text (right after a soul edit its cache is empty). Null when absent.
 */
export function parseManager(text: string): string | null {
  let inReporting = false;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (isCodeFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^##?\s/.test(line)) {
      inReporting = /^##\s+reporting\s*$/i.test(line.trim());
      continue;
    }
    if (!inReporting) continue;
    const kv = keyValue(line);
    if (kv?.[0] !== "manager") continue;
    const m = /^(?:<@)?([UW][A-Z0-9]+)(?:\|[^>]*)?>?$/.exec(kv[1]);
    return m ? m[1]! : null;
  }
  return null;
}

/** The mandates in a SOUL text, with each sub-mandate's mode and the scope blocks. */
export interface ParsedMandates {
  global: string;
  channels: Record<string, string>;
  /** Channel id -> its `Mode:` line, only when it wrote one. */
  modes: Record<string, MandateMode>;
  scopes: ScopeMandate[];
  /** `<place>: <value>` for each `Mode:` line whose value is not a known mode (read as extend). */
  unknownModes: string[];
}

/**
 * A persona's mandates from the SOUL text: `## Mandate`, `### Mandate` per
 * channel and per `## Scope dm|public|trusted`, each with an optional first
 * `Mode:` line. For when the LLM extraction has not run for this exact soul text.
 */
export function parseScopedMandates(text: string): ParsedMandates {
  const global: string[] = [];
  const channels: Record<string, string[]> = {};
  const scopes: Record<string, string[]> = {};
  const modes: Record<string, MandateMode> = {};
  const unknownModes: string[] = [];
  let target: string[] | null = null;
  let channel: string | null = null;
  let scope: string | null = null;
  /** The sub-mandate whose first line may still be a `Mode:` line. */
  let openMode: string | null = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (isCodeFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^##\s/.test(line)) {
      channel = /^##\s+channel\b/i.test(line) ? channelOf(line) : null;
      scope = /^##\s+scope\s+(dm|public|trusted)\s*$/i.exec(line.trim())?.[1]?.toLowerCase() ?? null;
      target = /^##\s+mandate\s*$/i.test(line.trim()) ? global : null;
      openMode = null;
      continue;
    }
    if (/^#\s/.test(line)) {
      channel = null;
      scope = null;
      target = null;
      openMode = null;
      continue;
    }
    if (/^###\s/.test(line)) {
      const isMandate = /^###\s+mandate\s*$/i.test(line.trim());
      target = isMandate && channel ? (channels[channel] ??= []) : isMandate && scope ? (scopes[scope] ??= []) : null;
      openMode = target && (channel ?? (scope ? `scope:${scope}` : null));
      continue;
    }
    const body = line.trim().replace(/^[-*]\s+/, "");
    if (!target || !body) continue;
    if (openMode) {
      const parsed = parseModeLine(body);
      const key = openMode;
      openMode = null;
      if (parsed) {
        modes[key] = parsed.mode;
        if (parsed.unknown !== undefined) unknownModes.push(`${key}: ${parsed.unknown}`);
        continue;
      }
    }
    target.push(body);
  }
  const join = (o: Record<string, string[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.join(" ")]));
  const scopeMode = (s: string) => modes[`scope:${s}`];
  const channelModes = Object.fromEntries(Object.entries(modes).filter(([k]) => !k.startsWith("scope:")));
  return {
    global: global.join(" "),
    channels: join(channels),
    modes: channelModes,
    unknownModes,
    scopes: Object.entries(join(scopes)).map(([s, mandate]) => ({
      scope: s as ScopeMandate["scope"],
      mandate,
      ...(scopeMode(s) ? { mode: scopeMode(s) } : {}),
    })),
  };
}

/** The global mandate and each channel's own text. See {@link parseScopedMandates}. */
export function parseMandates(text: string): { global: string; channels: Record<string, string> } {
  const { global, channels } = parseScopedMandates(text);
  return { global, channels };
}

/** True when the persona's SOUL enables proactiveness in any channel. */
export function anyProactiveEnabled(personaId: string): boolean {
  const c = configFor(personaId);
  return !!c && Object.entries(c.channels).some(([id, on]) => on && !c.invalidSessions.includes(id));
}
