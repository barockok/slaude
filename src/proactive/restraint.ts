/**
 * The restraint rules for a proactive post (spec §10.4; invariant 3), enforced
 * in code so they hold whatever the model decides. Pure: the caller supplies
 * the switch, the recipient's preferences and the recipient's recent posts.
 *
 * Audience ladder:
 *   manager  DM to the SOUL's manager      the global switch is on
 *   person   DM to anyone else             global on, they opted in (`pings: yes`)
 *                                          and the post's topic is one of theirs
 *   channel  a channel                     the channel resolves on
 *
 * Then, for every audience: SOUL quiet hours (persona timezone), the
 * recipient's own quiet hours and mutes (people only), the per-recipient
 * daily cap and cooldown (a channel counts as one recipient), and
 * "unchanged": the same text to the same recipient within 7 days posts
 * nothing. A refusal names its rule. What is "meaningfully new" and whether
 * content concerns a channel are the model's calls, not checked here.
 */
import { createHash } from "node:crypto";
import { localParts } from "../background/calendar";
import type { Audience } from "../db/proactive-posts";
import { inWindow, type ResolvedProactive } from "../soul/proactive";
import { muted, optedIn, type PingPrefs } from "./prefs";

export type { Audience };

export interface ProactiveRequest {
  audience: Audience;
  /** A user id (manager, person) or a channel id. */
  recipient: string;
  topic: string;
  text: string;
}

export type RestraintRule =
  | "disabled"
  | "not-manager"
  | "not-opted-in"
  | "topic-not-opted-in"
  | "channel-disabled"
  | "muted"
  | "quiet-hours"
  | "daily-cap"
  | "cooldown"
  | "unchanged";

export interface RestraintContext {
  /** The persona's switch, for a channel when given (proactiveFor). */
  config: (channelId?: string) => ResolvedProactive;
  managerId: string | null;
  /** The recipient's preferences (NO_PREFS for a channel). */
  prefs: PingPrefs;
  now: Date;
  /** The persona's timezone. */
  timeZone: string;
  /** The recipient's proactive posts of the last UNCHANGED_WINDOW_MS at least. */
  history: ReadonlyArray<{ postedAt: number; textHash: string }>;
}

/** "Unchanged" looks back this far. */
export const UNCHANGED_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A hash of the text as a reader sees it: Slack markup, case and spacing ignored. */
export function textHash(text: string): string {
  const norm = text
    .replace(/<[@#!]?(?:[^|>]*\|)?([^>]*)>/g, "$1")
    .replace(/[*_~`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm).digest("hex");
}

export function checkProactive(req: ProactiveRequest, ctx: RestraintContext): { ok: true } | { ok: false; rule: RestraintRule } {
  const no = (rule: RestraintRule) => ({ ok: false as const, rule });
  const isPerson = req.audience !== "channel";
  const cfg = ctx.config(req.audience === "channel" ? req.recipient : undefined);

  if (req.audience === "manager") {
    if (!cfg.enabled) return no("disabled");
    if (!ctx.managerId || req.recipient !== ctx.managerId) return no("not-manager");
  } else if (req.audience === "person") {
    if (!cfg.enabled) return no("disabled");
    if (!ctx.prefs.pings) return no("not-opted-in");
    if (!optedIn(ctx.prefs, req.topic)) return no("topic-not-opted-in");
  } else if (!cfg.enabled) {
    return no("channel-disabled");
  }

  if (isPerson && muted(ctx.prefs, req.topic)) return no("muted");

  const local = localParts(ctx.now, ctx.timeZone);
  if (cfg.quietHours && inWindow(local.minutes, cfg.quietHours)) return no("quiet-hours");
  if (isPerson && ctx.prefs.quietHours) {
    const theirs = localParts(ctx.now, ctx.prefs.timeZone ?? ctx.timeZone).minutes;
    if (inWindow(theirs, ctx.prefs.quietHours)) return no("quiet-hours");
  }

  const t = ctx.now.getTime();
  const today = ctx.history.filter((h) => localParts(new Date(h.postedAt), ctx.timeZone).day === local.day);
  if (today.length >= cfg.maxPerPersonPerDay) return no("daily-cap");
  const latest = Math.max(-Infinity, ...ctx.history.map((h) => h.postedAt));
  if (t - latest < cfg.cooldownHours * 3_600_000) return no("cooldown");
  const hash = textHash(req.text);
  if (ctx.history.some((h) => h.textHash === hash && t - h.postedAt < UNCHANGED_WINDOW_MS)) return no("unchanged");
  return { ok: true };
}
