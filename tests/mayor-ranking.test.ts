import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MayorLeague } from '../src/backend/mayor-ranking';
import { Store } from '../src/backend/store';
import { defaultConfig } from '../src/shared/defaults';

let store: Store;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  const config = defaultConfig('/tmp');
  config.organizations = ['corp'];
  config.onboardingComplete = true;
  config.workspace.members[0].externalLogin = 'Alice';
  store = new Store(':memory:', config);
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
});
const period = { start: '2026-11-05', end: '2026-11-05' };
const item = (id: number, login = 'alice', type = 'User') => ({
  id,
  user: { login, type },
  repository_url: 'https://api.github.com/repos/corp/repo',
});
const response = (items: ReturnType<typeof item>[]) => ({
  total_count: items.length,
  incomplete_results: false,
  items,
});
it('ranks human authors with ties, excludes bots, and keeps peers out of personal contributions', async () => {
  const fetch = vi.fn(async () =>
    response([item(1), item(2), item(3, 'bob'), item(4, 'bob'), item(5, 'carol'), item(6, 'robot', 'Bot')]),
  );
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  const view = league.view(period);
  expect(view.partial).toBe(false);
  expect(view.rows.map((r) => r.rank)).toEqual([1, 1, 3]);
  expect(view.rows[0]).toMatchObject({ login: 'alice', me: true, merged: 2 });
  expect(view.mean).toBeCloseTo(5 / 3);
  expect(view.median).toBe(2);
  expect(view.difference).toBeCloseTo(20);
  expect(store.getContributions()).toHaveLength(0);
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  const reopened = new MayorLeague(store, () => fetch);
  reopened.view(period);
  await reopened.tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-11-05T14:00:01Z'));
  await reopened.tick();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('caps a round at 20 searches and resumes missing days after restart', async () => {
  const fetch = vi.fn(async () => response([]));
  const league = new MayorLeague(store, () => fetch);
  const range = { start: '2026-10-07', end: '2026-11-05' };
  league.view(range);
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(20);
  expect(league.view(range)).toMatchObject({ completedDays: 20, totalDays: 30, partial: true });
  vi.setSystemTime(new Date('2026-11-05T14:01:00Z'));
  const restarted = new MayorLeague(store, () => fetch);
  restarted.view(range);
  await restarted.tick();
  expect(restarted.view(range)).toMatchObject({ completedDays: 30, partial: false });
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(40);
});
it('rejects incomplete search results and retains the last confirmed snapshot', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([item(1)]))
    .mockResolvedValue({ total_count: 10, incomplete_results: true, items: [] });
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  vi.setSystemTime(new Date('2026-11-05T14:00:01Z'));
  await league.tick();
  expect(league.view(period)).toMatchObject({ mine: 1, partial: true });
  expect(league.view(period).error).toContain('incompleta');
  expect(new MayorLeague(store, () => fetch).view(period).error).toContain('incompleta');
});
it('splits searches above 1000 results rather than silently truncating', async () => {
  const fetch = vi.fn(async (endpoint: string) => {
    const query = decodeURIComponent(endpoint);
    return query.includes('03:00:00Z..2026-11-06T02:59:59Z')
      ? { total_count: 1001, incomplete_results: false, items: [] }
      : response([item(query.includes('03:00:00Z') ? 1 : 2)]);
  });
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(league.view(period)).toMatchObject({ mine: 2, partial: false });
});
it('never queries before 2026 and isolates changed organization scopes', async () => {
  const fetch = vi.fn(async (_endpoint: string) => response([item(1)]));
  const league = new MayorLeague(store, () => fetch);
  league.view({ start: '2025-12-31', end: '2026-01-01' });
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(decodeURIComponent(fetch.mock.calls[0]?.[0] ?? '')).not.toContain('2025');
  store.saveConfig({ ...store.getConfig(), organizations: ['other'] });
  expect(league.view(period).rows).toHaveLength(0);
  expect(() => league.interval(0)).toThrow();
  league.interval(3);
  expect(league.interval()).toBe(3);
});
it('does no work while personal imports are running or paused', async () => {
  const fetch = vi.fn(async () => response([]));
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects changed pagination without publishing an incomplete day', async () => {
  const fetch = vi.fn(async (endpoint: string) =>
    endpoint.includes('page=1&')
      ? { total_count: 101, incomplete_results: false, items: Array.from({ length: 100 }, (_, i) => item(i)) }
      : { total_count: 102, incomplete_results: false, items: [item(100)] },
  );
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  expect(league.view(period)).toMatchObject({ completedDays: 0, partial: true, mine: 0 });
  expect(league.view(period).error).toContain('mudaram');
});

it('keeps the author with zero PRs out of the active-author denominator and isolates duplicates', async () => {
  store.saveConfig({ ...store.getConfig(), organizations: ['corp', 'CORP'] });
  const fetch = vi.fn(async () => response([item(1, 'bob')]));
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(league.view(period)).toMatchObject({ mean: 1, mine: 0, difference: -100, totalDays: 1 });
  expect(league.view(period).rows.some((row) => row.me)).toBe(false);
});

it('manually refreshes confirmed historical days before the scheduled interval', async () => {
  const fetch = vi.fn(async () => response([item(1)]));
  const league = new MayorLeague(store, () => fetch);
  const historical = { start: '2026-09-01', end: '2026-09-01' };
  league.view(historical);
  await league.tick();
  vi.setSystemTime(new Date('2026-11-05T12:01:00Z'));
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  await league.tick(false, true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(league.view(historical)).toMatchObject({ partial: false, completedDays: 1 });
});

it('resumes the remainder of a bounded manual refresh after restart', async () => {
  const fetch = vi.fn(async () => response([]));
  const range = { start: '2026-09-01', end: '2026-09-25' };
  let league = new MayorLeague(store, () => fetch);
  league.view(range);
  await league.tick();
  vi.setSystemTime(new Date('2026-11-05T14:01:00Z'));
  await league.tick();
  expect(league.view(range).partial).toBe(false);
  vi.setSystemTime(new Date('2026-11-05T14:02:00Z'));
  await league.tick(false, true);
  expect(league.view(range)).toMatchObject({ partial: true, completedDays: 20, totalDays: 25 });
  league = new MayorLeague(store, () => fetch);
  league.view(range);
  vi.setSystemTime(new Date('2026-11-05T16:03:00Z'));
  await league.tick();
  expect(league.view(range)).toMatchObject({ partial: false, completedDays: 25 });
});

it('counts merges within local midnight boundaries rather than the UTC calendar day', async () => {
  const merges = [
    '2026-11-05T02:59:59Z',
    '2026-11-05T03:00:00Z',
    '2026-11-06T02:59:59Z',
    '2026-11-06T03:00:00Z',
  ];
  const fetch = vi.fn(async (endpoint: string) => {
    const query = new URL(`https://api.github.com/${endpoint}`).searchParams.get('q') ?? '';
    const range = query.match(/merged:(\S+)\.\.(\S+)/);
    if (!range) throw new Error('Missing merge date range');
    return response(merges.flatMap((date, i) => (date >= range[1] && date <= range[2] ? [item(i)] : [])));
  });
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  expect(league.view(period)).toMatchObject({ mine: 2, partial: false });
  expect(decodeURIComponent(fetch.mock.calls[0][0])).toContain(
    'merged:2026-11-05T03:00:00Z..2026-11-06T02:59:59Z',
  );
});

it('isolates timezone caches and rechecks without waiting for the previous scope interval', async () => {
  const fetch = vi.fn(async () => response([item(1)]));
  const league = new MayorLeague(store, () => fetch);
  league.view(period);
  await league.tick();
  const config = store.getConfig();
  store.saveConfig({ ...config, calendar: { ...config.calendar, timezone: 'Asia/Tokyo' } });
  expect(league.view(period)).toMatchObject({ mine: 0, partial: true });
  await league.tick();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(league.view(period)).toMatchObject({ mine: 1, partial: false });
});

it('uses the local date for rolling periods and does not query local tomorrow', async () => {
  vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
  const fetch = vi.fn(async () => response([]));
  const league = new MayorLeague(store, () => fetch);
  expect(league.view({ ...period, rolling: true }).period).toEqual({
    start: '2026-10-07',
    end: '2026-11-05',
    rolling: true,
  });
  expect(league.view({ start: '2026-11-05', end: '2026-11-06' }).totalDays).toBe(1);
  const config = store.getConfig();
  store.saveConfig({ ...config, calendar: { ...config.calendar, timezone: 'Asia/Tokyo' } });
  expect(league.view({ ...period, rolling: true }).period.end).toBe('2026-11-06');
  expect(league.view({ start: '2026-11-05', end: '2026-11-06' }).totalDays).toBe(2);
});
