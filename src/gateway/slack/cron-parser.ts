export type CronFields = {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
};

function parseField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) throw new Error(`invalid step: ${field}`);
    const vals: number[] = [];
    for (let i = min; i <= max; i += step) vals.push(i);
    return vals;
  }
  if (field.includes("-")) {
    const parts = field.split("-");
    if (parts.length !== 2) throw new Error(`invalid range: ${field}`);
    const start = parseInt(parts[0]!, 10);
    const end = parseInt(parts[1]!, 10);
    if (isNaN(start) || isNaN(end)) throw new Error(`invalid range: ${field}`);
    const vals: number[] = [];
    for (let i = start; i <= end; i++) vals.push(i);
    return vals;
  }
  const n = parseInt(field, 10);
  if (isNaN(n)) throw new Error(`invalid field: ${field}`);
  return [n];
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got: ${expr}`);
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 6),
  };
}

/** Compute the next run time after `after` (default now). */
export function getNextRun(expr: string, after?: number): number {
  const fields = parseCron(expr);
  const start = after ?? Date.now();
  const d = new Date(start);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  // Safety: cap search at ~4 years
  const maxIterations = 366 * 24 * 60 * 4;
  for (let i = 0; i < maxIterations; i++) {
    const min = d.getUTCMinutes();
    const hr = d.getUTCHours();
    const dom = d.getUTCDate();
    const mon = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();

    if (
      fields.minute.includes(min) &&
      fields.hour.includes(hr) &&
      fields.dayOfMonth.includes(dom) &&
      fields.month.includes(mon) &&
      fields.dayOfWeek.includes(dow)
    ) {
      return d.getTime();
    }
    d.setUTCMinutes(min + 1);
  }
  throw new Error(`could not find next run for cron: ${expr}`);
}
