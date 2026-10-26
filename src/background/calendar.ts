/** Calendar helpers for persona-local schedules (pure; YYYY-MM-DD strings). */

/** The persona-local wall clock of an instant. weekday: 1 = Monday … 7 = Sunday (ISO). */
export function localParts(at: Date, timeZone: string): { day: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")), weekday };
}

const utc = (day: string): Date => new Date(`${day}T00:00:00Z`);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** The calendar day before `day`. */
export function previousDay(day: string): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() - 1);
  return ymd(d);
}

/** The ISO week a calendar day falls in, as `YYYY-Www`. */
export function isoWeekSlot(day: string): string {
  const d = utc(day);
  const dow = d.getUTCDay() || 7;
  // The week's Thursday decides its year.
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
