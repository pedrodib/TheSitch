import { expect, it } from 'vitest';
import { localDayStart } from '../src/shared/period';

it.each([
  ['2026-11-05', 'America/Sao_Paulo', '2026-11-05T03:00:00.000Z', 24],
  ['2026-11-05', 'Asia/Kolkata', '2026-11-04T18:30:00.000Z', 24],
  ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', 23],
  ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', 25],
  ['2026-11-05', 'Pacific/Kiritimati', '2026-11-04T10:00:00.000Z', 24],
])('resolves the local day %s in %s', (date, timezone, expected, hours) => {
  const start = localDayStart(date, timezone);
  const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  expect(new Date(start).toISOString()).toBe(expected);
  expect(localDayStart(next, timezone) - start).toBe(hours * 3600000);
});
