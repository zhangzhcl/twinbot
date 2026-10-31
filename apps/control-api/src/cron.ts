/**
 * Minimal 5-field cron evaluator (minute hour day-of-month month day-of-week).
 * Supports *, N, ranges, and step syntax (star-slash-N). Day-of-week: 0-6 (Sun=0) or 7=Sun.
 */

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^(\*|\d+)-?(\d+)?\/(\d+)$/.exec(part) ||
      /^(\*)\/(\d+)$/.exec(part);
    if (part === '*') {
      for (let i = min; i <= max; i += 1) values.add(i);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < min || n > max) return null;
      values.add(n);
      continue;
    }
    const rangeStep = /^(\d+|\*)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!rangeStep) return null;
    const start = rangeStep[1] === '*' ? min : Number(rangeStep[1]);
    const end = rangeStep[2] !== undefined ? Number(rangeStep[2]) : (rangeStep[1] === '*' ? max : start);
    const step = rangeStep[3] !== undefined ? Number(rangeStep[3]) : 1;
    if (![start, end, step].every((n) => Number.isInteger(n)) || step < 1) return null;
    if (start < min || end > max || start > end) return null;
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return values;
}

export function parseCronExpression(expr: string): {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
} | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const daysOfWeek = parseField(parts[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  // Normalize 7 -> 0 (Sunday)
  if (daysOfWeek.has(7)) {
    daysOfWeek.add(0);
    daysOfWeek.delete(7);
  }
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export function cronMatches(expr: string, date: Date): boolean {
  const parsed = parseCronExpression(expr);
  if (!parsed) return false;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();
  return (
    parsed.minutes.has(minute) &&
    parsed.hours.has(hour) &&
    parsed.months.has(month) &&
    parsed.daysOfMonth.has(day) &&
    parsed.daysOfWeek.has(dow)
  );
}

/** Next fire time after `from` (exclusive), scanning minute-by-minute up to 366 days. */
export function nextCronFire(expr: string, from: Date): Date | null {
  if (!parseCronExpression(expr)) return null;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(expr, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
