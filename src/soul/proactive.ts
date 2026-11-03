/**
 * The proactiveness switch (spec §10.2; invariant 3): a `## Proactive` section
 * of the persona's SOUL, plus `### Proactive` inside a `## Channel <#C…>`
 * block, in either direction.
 *
 * One setting turns it on, in the place it applies to:
 *
 *   ## Channel <#C…>
 *   ### Proactive
 *   - Enabled: yes           # the agent works on its own here; its mandate says what it may do
 *
 *   ## Proactive
 *   - Enabled: yes           # the same for its manager's DM (and people who opted in)
 *
 * Everything else is optional and has a sensible default:
 *   - Max per day: 6         # posts per recipient per day (either section)
 *   - Quiet hours: 21:00–08:00
 *   - Read: <#C…>, <#C…>     # further channels it may read, in any turn (global only)
 *   - Watch: mail, tracker   # external sources for the locked triage round (global only)
 *
 * Still honoured so a soul can narrow things, never needed to turn anything on:
 *   - Wake: no               # stay on the summarising round (global only)
 *   - Highest: ask           # lower the ceiling: ignore | inform | ask (default act)
 *   - Cooldown: 4 hours      # minimum gap between posts to one recipient
 *   - Max per person per day # the old name of Max per day
 *
 * Parsed here, deterministically, from the persona's SOUL text. Never through
 * the LLM structured extraction (a mis-extraction must never turn it on), never
 * through runtime overrides (src/soul/overrides.ts), never by a command. Only
 * the SOUL can raise it; a person's profile can only lower it (restraint.ts).
 */
import { createHash } from "node:crypto";
import { personaSoulText } from "../persona/soul-source";
import { parseLevel, type Level } from "../proactive/levels";

export interface QuietHours {
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

export interface ProactiveConfig {
  enabled: boolean;
  quietHours: QuietHours | null;
  maxPerPersonPerDay: number;
  cooldownHours: number;
  /** Sources the heartbeat round reads (global only). */
  watch: string[];
  /** The ceiling no learned reaction may raise the level past. */
  highest: Level;
  /** Whether the agent itself wakes for its checklist (global only). */
  wake: boolean;
  /** Channels this agent may read with read_channel (global only). */
  read: string[];
  /** Channel id → that channel's own `### Proactive` `Enabled`. */
  channels: Record<string, boolean>;
  /** Channel id → that channel's own `### Proactive` `Highest`. */
  channelHighest: Record<string, Level>;
  /** Channel id → that channel's own `### Proactive` `Cooldown`, in hours. */
  channelCooldownHours: Record<string, number>;
  /** Channel id → that channel's own `### Proactive` `Max per day`. */
  channelMaxPerDay: Record<string, number>;
}

/** The resolved switch for one audience: the global settings, `enabled` per channel when one is given. */
export type ResolvedProactive = Omit<ProactiveConfig, "wake" | "read" | "channels" | "channelHighest" | "channelCooldownHours" | "channelMaxPerDay">;

export const DEFAULT_MAX_PER_PERSON_PER_DAY = 6;
export const DEFAULT_COOLDOWN_HOURS = 1;

const DISABLED: ResolvedProactive = {
  enabled: false,
  quietHours: null,
  maxPerPersonPerDay: DEFAULT_MAX_PER_PERSON_PER_DAY,
  cooldownHours: DEFAULT_COOLDOWN_HOURS,
  watch: [],
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
function channelOf(heading: string): string | null {
  const m = /^##\s+channel\s+(?:<#([A-Za-z0-9]+)(?:\|[^>]*)?>|([A-Za-z0-9]+))/i.exec(heading.trim());
  const id = m ? (m[1] ?? m[2])! : "";
  return CHANNEL_ID.test(id) ? id : null;
}

/** One `- Key: value` line (also `*`), comment after `#` dropped. */
function keyValue(line: string): [string, string] | null {
  const m = /^\s*[-*]\s*([^:]+):\s*(.*)$/.exec(line);
  if (!m) return null;
  return [m[1]!.trim().toLowerCase(), m[2]!.replace(/\s+#.*$/, "").trim()];
}

/** Channel ids from a comma-separated SOUL value (`<#C…|name>` or `C…`); anything else is dropped. */
function parseChannelList(value: string): string[] {
  const ids = value.split(",").map((v) => /^\s*(?:<#([A-Za-z0-9]+)(?:\|[^>]*)?>|([A-Za-z0-9]+))\s*$/.exec(v)).map((m) => (m ? (m[1] ?? m[2])! : ""));
  return ids.filter((id) => CHANNEL_ID.test(id));
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
    enabled: false,
    quietHours: null,
    maxPerPersonPerDay: DEFAULT_MAX_PER_PERSON_PER_DAY,
    cooldownHours: DEFAULT_COOLDOWN_HOURS,
    watch: [],
    // Where proactiveness is on, the mandate is the authority: the ceiling only narrows.
    highest: "act",
    wake: true,
    read: [],
    channels: {},
    channelHighest: {},
    channelCooldownHours: {},
    channelMaxPerDay: {},
  };
  // Where we are: the global section, a channel's Proactive subsection, or elsewhere.
  let where: { kind: "global" } | { kind: "channel"; id: string; inProactive: boolean } | null = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
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
        where = id ? { kind: "channel", id, inProactive: false } : null;
      }
      continue;
    }
    if (/^###\s/.test(line)) {
      if (where?.kind === "channel") where.inProactive = /^###\s+proactive\s*$/i.test(line.trim());
      else where = null;
      continue;
    }
    if (!where) continue;
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (where.kind === "channel") {
      if (!where.inProactive) continue;
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
    if (key === "enabled") out.enabled = value.toLowerCase() === "yes";
    else if (key === "wake") out.wake = value.toLowerCase() === "yes";
    else if (key === "read") out.read = parseChannelList(value);
    else if (key === "watch") out.watch = value.split(",").map((w) => w.trim()).filter(Boolean);
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
      if (memo.size > 64) memo.clear();
      memo.set(key, c);
    }
    return c;
  } catch {
    return null;
  }
}

/**
 * The switch for a persona, for one channel when given: that channel's own
 * `### Proactive` when it has one, else the global value
 * (`watch` is always the global value). Any failure reads
 * as disabled.
 */
export function proactiveFor(personaId: string, channelId?: string): ResolvedProactive {
  const c = configFor(personaId);
  if (!c) return { ...DISABLED };
  const { wake: _wake, read: _read, channels, channelHighest, channelCooldownHours, channelMaxPerDay, ...global } = c;
  if (channelId === undefined) return global;
  return {
    ...global,
    enabled: channels[channelId] ?? global.enabled,
    highest: channelHighest[channelId] ?? global.highest,
    cooldownHours: channelCooldownHours[channelId] ?? global.cooldownHours,
    maxPerPersonPerDay: channelMaxPerDay[channelId] ?? global.maxPerPersonPerDay,
  };
}

/** The channels whose own `### Proactive` turns proactiveness on. */
export function proactiveChannels(personaId: string): string[] {
  const c = configFor(personaId);
  return c ? Object.entries(c.channels).filter(([, on]) => on).map(([id]) => id).sort() : [];
}

/** The channels this persona may read with read_channel: where it works on its own, and any its SOUL lists. */
export function proactiveRead(personaId: string): string[] {
  const c = configFor(personaId);
  return c ? [...new Set([...c.read, ...proactiveChannels(personaId)])] : [];
}

export type WakeEligibility = { ok: true } | { ok: false; reason: "no-manager" | "no-act-destination" | null };

/**
 * Whether a persona wakes: proactiveness is on somewhere, it has a manager, and
 * no soul line narrowed every enabled place below `act`. `reason: null` is a
 * persona that never turned proactiveness on (or said `Wake: no`); any other
 * reason is a misconfiguration worth saying out loud.
 */
export function wakeEligibility(personaId: string, managerId: string | null): WakeEligibility {
  const c = configFor(personaId);
  if (!c?.wake || !(c.enabled || Object.values(c.channels).some(Boolean))) return { ok: false, reason: null };
  if (!managerId) return { ok: false, reason: "no-manager" };
  const globalAct = c.enabled && c.highest === "act";
  const channelAct = Object.entries(c.channels).some(([id, on]) => on && (c.channelHighest[id] ?? c.highest) === "act");
  return globalAct || channelAct ? { ok: true } : { ok: false, reason: "no-act-destination" };
}

/** True when the persona's SOUL enables proactiveness globally or in any channel. */
export function anyProactiveEnabled(personaId: string): boolean {
  const c = configFor(personaId);
  return !!c && (c.enabled || Object.values(c.channels).some(Boolean));
}
