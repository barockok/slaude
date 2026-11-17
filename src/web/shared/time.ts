/**
 * Time display helpers shared by the console and the portal: relative times,
 * absolute times and short dates, in the viewer's locale and time zone.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a short date. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const d = now - at;
  if (d < 0) return relativeFuture(-d) ?? absoluteTime(at);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return shortDate(at);
}

/** "in 5 min", "in 3 h", "in 2 d"; null beyond a month. */
export function relativeFuture(d: number): string | null {
  if (d < HOUR) return `in ${Math.max(1, Math.round(d / MINUTE))} min`;
  if (d < DAY) return `in ${Math.round(d / HOUR)} h`;
  if (d < 30 * DAY) return `in ${Math.round(d / DAY)} d`;
  return null;
}

/** "Nov 7, 2026, 14:05:09" in the viewer's locale and time zone. */
export function absoluteTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A future time for an expiry: relative when soon, a date otherwise. */
export function expiryLabel(at: number | null, now: number = Date.now()): string {
  if (at == null) return "Never";
  if (at <= now) return "Expired";
  return relativeFuture(at - now) ?? shortDate(at);
}
