import { localDate } from './contributions';
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

/** First UTC second belonging to a local calendar day, including midnight/DST transitions. */
export function localDayStart(date: string, timezone: string): number {
  const center = Date.parse(`${date}T00:00:00Z`) / 1000;
  let low = center - 36 * 3600;
  let high = center + 36 * 3600;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(new Date(middle * 1000), timezone) < date) low = middle + 1;
    else high = middle;
  }
  return low * 1000;
}
