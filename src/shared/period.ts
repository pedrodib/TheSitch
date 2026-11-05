import type { Period } from './types';

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function isValidPeriod(period: Period): boolean {
  return (
    isCalendarDate(period.start) &&
    isCalendarDate(period.end) &&
    period.start <= period.end &&
    (Date.parse(period.end) - Date.parse(period.start)) / 86400000 <= 3660
  );
}
