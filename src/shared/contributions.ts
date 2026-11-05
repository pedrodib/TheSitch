import type { Contribution, Period } from './types';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Stable delivery identity; explicit null is an override of automatic work-item grouping. */
export function deliveryKey(item: Contribution): string {
  return item.groupId === null ? item.id : item.groupId || item.linkedWorkItem || item.id;
}
export function localDate(value: string | Date, timezone: string): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timezone, formatter);
  }
  return formatter.format(new Date(value));
}
export function inPeriod(item: Contribution, period: Period, timezone: string): boolean {
  return [item.occurredAt, item.mergedAt, item.deployedAt, item.updatedAt].some((value) => {
    if (!value) return false;
    const date = localDate(value, timezone);
    return date >= period.start && date <= period.end;
  });
}
