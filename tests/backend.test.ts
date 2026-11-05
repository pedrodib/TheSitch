import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDashboard, isBusinessDay, previousPeriod } from '../src/backend/metrics';
import { Store } from '../src/backend/store';
import { defaultConfig } from '../src/shared/defaults';
import type { Contribution, ImportResult, SyncStatus } from '../src/shared/types';

const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const config = () => {
  const value = defaultConfig('/tmp');
  value.organizations = ['org'];
  return value;
};
const contribution = (id: string, occurredAt = '2026-10-05T15:00:00Z'): Contribution => ({
  id,
  workspaceId: 'local-workspace',
  memberId: 'local-member',
  repositoryId: 'repo',
  source: 'github',
  externalId: id,
  kind: 'pull_request',
  title: id,
  body: '',
  url: '',
  occurredAt,
  updatedAt: occurredAt,
  state: 'merged',
  additions: 1,
  deletions: 0,
  participants: ['local-member'],
  labels: [],
});
const imported = (contributions: Contribution[]): ImportResult => ({
  repositories: [
    {
      id: 'repo',
      workspaceId: 'local-workspace',
      name: 'repo',
      fullName: 'org/repo',
      url: '',
      description: '',
    },
  ],
  contributions,
  tokens: [],
  errors: [],
  complete: true,
  coverageStart: '2026-01-01',
});
const status: SyncStatus = {
  running: false,
  paused: false,
  phase: '',
  lastSync: null,
  errors: [],
  coverageStart: '2026-01-01',
  coverageComplete: true,
};
it('compares partial calendar weeks and months with matching prior windows', () => {
  expect(previousPeriod({ start: '2026-11-02', end: '2026-11-04' })).toEqual({
    start: '2026-10-26',
    end: '2026-10-28',
  });
  expect(previousPeriod({ start: '2026-03-01', end: '2026-03-31' })).toEqual({
    start: '2026-02-01',
    end: '2026-02-28',
  });
});
it('keeps manual holidays when automatic holidays are disabled', () => {
  const c = config();
  c.calendar.automaticHolidayDates = { '2026-10-06': 'Importado' };
  c.calendar.holidays = { '2026-10-07': 'Manual' };
  c.calendar.automaticHolidays = false;
  expect(isBusinessDay('2026-10-06', c.calendar)).toBe(true);
  expect(isBusinessDay('2026-10-07', c.calendar)).toBe(false);
});

describe('SQLite store', () => {
  it('persists, deduplicates external identity, preserves groups, and isolates workspaces', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sitch-'));
    folders.push(folder);
    const path = join(folder, 'data.sqlite');
    let store = new Store(path, config());
    store.importResult(imported([contribution('a'), contribution('b')]));
    store.groupContributions(['a', 'b'], 'delivery');
    store.importResult(imported([{ ...contribution('a'), id: 'different-local-id', title: 'updated' }]));
    store.setCheckpoint('github', 'cursor');
    store.close();
    store = new Store(path, config());
    expect(store.getContributions()).toHaveLength(2);
    expect(store.getContributions()[0]).toMatchObject({ id: 'a', title: 'updated', groupId: 'delivery' });
    expect(store.getCheckpoint('github')).toBe('cursor');
    expect(store.getContributions(true).length).toBeGreaterThan(2);
    const next = store.getConfig();
    next.workspace.id = 'other';
    store.saveConfig(next);
    expect(store.getContributions()).toEqual([]);
    expect(store.getCheckpoint('github')).toBeNull();
    store.close();
  });
});
describe('team participation', () => {
  it('groups by explicit work item and permits a persisted manual override', () => {
    const store = new Store(':memory:', config());
    store.importResult(
      imported([
        { ...contribution('a'), linkedWorkItem: 'azure:org:123' },
        { ...contribution('b'), linkedWorkItem: 'azure:org:123' },
      ]),
    );
    const p = { start: '2026-10-01', end: '2026-10-31' };
    expect(
      buildDashboard(config(), [], store.getContributions(), [], status, p, false).metrics.deliveries,
    ).toBe(1);
    store.groupContributions(['a', 'b'], null);
    store.importResult(imported([{ ...contribution('a'), linkedWorkItem: 'azure:org:123' }]));
    expect(
      buildDashboard(config(), [], store.getContributions(), [], status, p, false).metrics.deliveries,
    ).toBe(2);
    store.close();
  });
  it('retains all participants and the original primary member after reimport', () => {
    const store = new Store(':memory:', config());
    store.importResult(imported([contribution('a')]));
    store.groupContributions(['a'], 'delivery');
    store.importResult(
      imported([{ ...contribution('a'), id: 'b', memberId: 'other-member', participants: ['other-member'] }]),
    );
    expect(store.getContributions()).toHaveLength(1);
    expect(store.getContributions()[0]).toMatchObject({
      id: 'a',
      memberId: 'local-member',
      groupId: 'delivery',
      participants: ['local-member', 'other-member'],
    });
    store.close();
  });
});
describe('organization filtering', () => {
  it('hides records for removed organizations without deleting them', () => {
    const store = new Store(':memory:', config());
    store.importResult(imported([contribution('a')]));
    expect(store.getContributions()).toHaveLength(1);
    const next = store.getConfig();
    next.organizations = ['other'];
    store.saveConfig(next);
    expect(store.getRepositories()).toHaveLength(0);
    expect(store.getContributions()).toHaveLength(0);
    next.organizations = ['ORG'];
    store.saveConfig(next);
    expect(store.getContributions()).toHaveLength(1);
    store.close();
  });
});
describe('calendar and dashboard', () => {
  it('uses configured holidays and workdays', () => {
    const calendar = config().calendar;
    expect(isBusinessDay('2026-10-03', calendar)).toBe(false);
    expect(isBusinessDay('2026-10-12', calendar)).toBe(false);
    calendar.excludedDates.push('2026-10-05');
    expect(isBusinessDay('2026-10-05', calendar)).toBe(false);
  });
  it('groups deliveries, excludes weekends from rhythm, and compares prior period', () => {
    const items = [
      { ...contribution('a'), groupId: 'g' },
      { ...contribution('b'), groupId: 'g' },
      contribution('weekend', '2026-10-03T15:00:00Z'),
      contribution('previous', '2026-09-29T15:00:00Z'),
    ];
    const dashboard = buildDashboard(
      config(),
      [],
      items,
      [],
      status,
      { start: '2026-10-03', end: '2026-10-09' },
      false,
    );
    expect(dashboard.metrics.deliveries).toBe(2);
    expect(dashboard.metrics.currentRate).toBe(0.2);
    expect(dashboard.previousMetrics.deliveries).toBe(1);
    expect(dashboard.metrics.baselineRate).not.toBeNull();
    expect(
      buildDashboard(config(), [], [], [], status, { start: '2026-10-03', end: '2026-10-04' }, false)
        .assessment.rhythm,
    ).toBe('neutral');
    expect(
      buildDashboard(
        config(),
        [],
        items,
        [],
        { ...status, coverageComplete: false },
        { start: '2026-10-03', end: '2026-10-09' },
        false,
      ).metrics.baselineRate,
    ).toBeNull();
  });
  it('counts completed code on its completion date and excludes open work', () => {
    const old = { ...contribution('old', '2026-09-01T15:00:00Z'), mergedAt: '2026-10-07T15:00:00Z' };
    const open = { ...contribution('open'), state: 'building' as const };
    const card = { ...contribution('card'), kind: 'work_item' as const };
    const dashboard = buildDashboard(
      config(),
      [],
      [old, open, card],
      [],
      status,
      { start: '2026-10-05', end: '2026-10-09' },
      false,
    );
    expect(dashboard.metrics.deliveries).toBe(1);
    expect(dashboard.metrics.daily.find((day) => day.date === '2026-10-07')?.deliveries).toBe(1);
    expect(dashboard.metrics.activeWorks).toBe(1);
    expect(dashboard.assessment.rhythm).toBe('insufficient');
  });
  it('treats the current day as provisional and leaves it out of the completed-day rate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z'));
    const today = contribution('today', '2026-10-07T15:00:00Z');
    const dashboard = buildDashboard(
      config(),
      [],
      [today],
      [],
      status,
      { start: '2026-10-05', end: '2026-10-07' },
      false,
    );
    expect(dashboard.assessment.provisional).toBe(true);
    expect(dashboard.metrics.deliveries).toBe(1);
    expect(dashboard.metrics.currentRate).toBe(0);
  });
  it('places grouped deliveries only on their latest completion date', () => {
    const a = { ...contribution('a'), groupId: 'g', mergedAt: '2026-10-05T15:00:00Z' };
    const b = { ...contribution('b'), groupId: 'g', mergedAt: '2026-10-08T15:00:00Z' };
    const d = buildDashboard(
      config(),
      [],
      [a, b],
      [],
      status,
      { start: '2026-10-05', end: '2026-10-09' },
      false,
    );
    expect(d.metrics.deliveries).toBe(1);
    expect(d.metrics.daily.map((day) => day.deliveries)).toEqual([0, 0, 0, 1, 0]);
    expect(
      buildDashboard(config(), [], [a, b], [], status, { start: '2026-10-05', end: '2026-10-05' }, false)
        .metrics.deliveries,
    ).toBe(0);
  });
  it('requires ten covered business days for a baseline', () => {
    const p = { start: '2026-10-05', end: '2026-10-09' };
    expect(
      buildDashboard(config(), [], [], [], { ...status, coverageStart: '2026-09-25' }, p, false).metrics
        .baselineRate,
    ).toBeNull();
    expect(
      buildDashboard(config(), [], [], [], { ...status, coverageStart: '2026-09-21' }, p, false).metrics
        .baselineRate,
    ).toBe(0);
  });
  it('does not reward weekend deliveries in baseline or current rhythm', () => {
    const p = { start: '2026-10-03', end: '2026-10-09' };
    const weekend = contribution('weekend', '2026-10-03T15:00:00Z');
    const priorWeekend = contribution('prior-weekend', '2026-09-26T15:00:00Z');
    const d = buildDashboard(config(), [], [weekend, priorWeekend], [], status, p, false);
    expect(d.metrics.deliveries).toBe(1);
    expect(d.metrics.currentRate).toBe(0);
    expect(d.metrics.baselineRate).toBe(0);
    expect(d.assessment.rhythm).toBe('insufficient');
  });
  it('excludes custom holidays and time off from expected days', () => {
    const c = config();
    c.calendar.holidays['2026-10-06'] = 'Local';
    c.calendar.excludedDates.push('2026-10-07');
    const d = buildDashboard(c, [], [], [], status, { start: '2026-10-05', end: '2026-10-09' }, false);
    expect(d.metrics.businessDays).toBe(3);
  });
  it('separates attributed, unassigned and analysis token usage', () => {
    const base = {
      workspaceId: 'local-workspace',
      memberId: 'local-member',
      sessionId: 'session',
      occurredAt: '2026-10-05T15:00:00Z',
      input: 10,
      cached: 0,
      output: 0,
      total: 10,
      model: 'test',
    };
    const tokens = [
      { ...base, id: 'a', repositoryId: 'repo', isTheSitch: false },
      { ...base, id: 'b', repositoryId: null, isTheSitch: false },
      { ...base, id: 'c', repositoryId: null, isTheSitch: true },
      { ...base, id: 'claude:1', repositoryId: 'repo', isTheSitch: false, provider: 'claude' as const },
    ];
    const d = buildDashboard(
      config(),
      [],
      [],
      tokens,
      status,
      { start: '2026-10-05', end: '2026-10-05' },
      false,
    );
    expect([d.metrics.tokens, d.metrics.unassignedTokens, d.metrics.analysisTokens]).toEqual([20, 10, 10]);
    expect(d.metrics.tokensByProvider).toEqual({ codex: 20, claude: 10 });
  });
});

it('counts authored commits separately without duplicating PR deliveries', () => {
  const pr = contribution('pr');
  const linked: Contribution = { ...contribution('linked'), kind: 'commit', associatedPullRequests: [7] };
  const direct: Contribution = { ...contribution('direct'), kind: 'commit' };
  const repeated = { ...linked, id: 'another-member-copy', memberId: 'other' };
  const old = { ...contribution('old', '2026-09-01T10:00:00Z'), kind: 'commit' as const };
  const result = buildDashboard(
    config(),
    [],
    [pr, linked, direct, repeated, old],
    [],
    status,
    { start: '2026-10-05', end: '2026-10-05' },
    false,
  );
  expect(result.metrics.commits).toBe(2);
  expect(result.metrics.pullRequests).toBe(1);
  expect(result.metrics.deliveries).toBe(2);
});

it('compares a rolling 30-day window with the immediately preceding 30 days, including month boundaries', () => {
  expect(previousPeriod({ start: '2026-11-01', end: '2026-11-30', rolling: true })).toEqual({
    start: '2026-10-02',
    end: '2026-10-31',
  });
  expect(previousPeriod({ start: '2026-02-01', end: '2026-03-02', rolling: true })).toEqual({
    start: '2026-01-02',
    end: '2026-01-31',
  });
});
