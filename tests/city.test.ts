import { describe, expect, it } from 'vitest';
import { createDemoData } from '../src/backend/demo';
import { buildDashboard } from '../src/backend/metrics';
import { buildCity, districtDevelopment } from '../src/renderer/city-model';
import { cityLight } from '../src/renderer/cyber-city';
import { mayorLevel } from '../src/renderer/mayor-meter';
import { defaultConfig } from '../src/shared/defaults';

const dashboard = () => {
  const result = buildDashboard(
    defaultConfig('/tmp'),
    [],
    [],
    [],
    {
      running: false,
      paused: false,
      phase: '',
      errors: [],
      lastSync: null,
      coverageStart: '2026-01-01',
      coverageComplete: true,
    },
    { start: '2026-10-01', end: '2026-10-30' },
    false,
  );
  result.metrics.baselineRate = 1;
  result.metrics.currentRate = 1;
  return result;
};
describe('Prefeitômetro', () => {
  it.each([
    [21, 5],
    [20, 4],
    [-20, 4],
    [-21, 3],
    [-40, 3],
    [-41, 2],
    [-60, 2],
    [-61, 1],
  ])('maps %s%% to level %s', (change, level) => {
    const value = dashboard();
    value.metrics.changePercent = change;
    expect(mayorLevel(value)).toBe(level);
  });
  it('does not issue an alert for rest days, incomplete data or zero baseline', () => {
    const value = dashboard();
    value.metrics.changePercent = -100;
    value.metrics.businessDays = 0;
    expect(mayorLevel(value)).toBeNull();
    value.metrics.businessDays = 10;
    value.status.coverageComplete = false;
    expect(mayorLevel(value)).toBeNull();
    value.status.coverageComplete = true;
    value.metrics.baselineRate = 0;
    expect(mayorLevel(value)).toBeNull();
    value.metrics.baselineRate = 1;
    value.metrics.currentRate = null;
    expect(mayorLevel(value)).toBeNull();
    expect(mayorLevel(null)).toBeNull();
  });
});
describe('city clock', () => {
  it.each([
    [4, 'night'],
    [5, 'dawn'],
    [6, 'dawn'],
    [7, 'day'],
    [16, 'day'],
    [17, 'dusk'],
    [18, 'dusk'],
    [19, 'night'],
    [23, 'night'],
  ])('uses the configured local hour %s for %s', (hour, phase) => {
    const date = new Date(`2026-11-05T${String(hour).padStart(2, '0')}:00:00-03:00`);
    expect(cityLight(date, 'America/Sao_Paulo').phase).toBe(phase);
  });
  it('uses the configured timezone instead of the runtime timezone', () => {
    const now = new Date('2026-11-05T09:00:00Z');
    expect(cityLight(now, 'UTC').phase).toBe('day');
    expect(cityLight(now, 'America/Sao_Paulo').phase).toBe('dawn');
  });
});

it('keeps district positions and exact counts while deliveries grow the skyline', () => {
  const data = createDemoData(defaultConfig('/tmp'));
  const repo = data.repositories[0];
  const period = { start: '2026-01-01', end: '2026-12-31' };
  const empty = buildCity([repo], [], period, period.end, 'UTC');
  const items = Array.from({ length: 24 }, (_, i) => ({
    ...data.contributions[0],
    repositoryId: repo.id,
    id: `test-${i}`,
    externalId: `test-${i}`,
    occurredAt: '2026-06-01T12:00:00Z',
    kind: 'commit' as const,
    associatedPullRequests: [],
  }));
  const developed = buildCity([repo], items, period, period.end, 'UTC');
  expect(developed.labels[0].point).toEqual(empty.labels[0].point);
  expect(empty.labels[0].count).toBe(0);
  expect(developed.labels[0].commits).toBe(24);
  expect(developed.labels[0].count).toBe(24);
  const height = (model: ReturnType<typeof buildCity>) =>
    Math.max(...model.faces.flatMap((f) => f.points.map((p) => p[2])));
  expect(height(developed)).toBeGreaterThan(height(empty));
  const replay = buildCity([repo], items, period, '2026-05-31', 'UTC', true);
  expect(replay.labels[0].count).toBe(0);
  expect(height(replay)).toBe(height(empty));
});

it('keeps early neighborhoods sparse and continues growing beyond thirty works', () => {
  const counts = [0, 1, 2, 10, 30, 60, 150];
  const stages = counts.map(districtDevelopment);
  expect(stages.map((stage) => stage.buildings)).toEqual([0, 1, 2, 5, 9, 12, 16]);
  expect(stages[4].height).toBeGreaterThan(stages[2].height * 5);
  for (let i = 1; i < stages.length; i++) {
    expect(stages[i].height).toBeGreaterThan(stages[i - 1].height);
  }
});

it('develops from all imported history independently of filters, excluding reviews and linked commits', () => {
  const data = createDemoData(defaultConfig('/tmp'));
  const repo = data.repositories[0];
  const period = { start: '2026-11-01', end: '2026-11-30' };
  const base = {
    ...data.contributions[0],
    repositoryId: repo.id,
    occurredAt: '2026-11-05T12:00:00Z',
    updatedAt: '2026-11-05T12:00:00Z',
    mergedAt: undefined,
    deployedAt: undefined,
    groupId: null,
    linkedWorkItem: undefined,
  };
  const items = [
    { ...base, id: 'pr', kind: 'pull_request' as const },
    { ...base, id: 'review', kind: 'review' as const },
    { ...base, id: 'linked', kind: 'commit' as const, associatedPullRequests: [1] },
    {
      ...base,
      id: 'old',
      kind: 'pull_request' as const,
      occurredAt: '2026-10-05T12:00:00Z',
      updatedAt: '2026-10-05T12:00:00Z',
    },
  ];
  const model = buildCity([repo], items, period, period.end, 'UTC');
  expect(model.labels[0].works).toBe(2);
  const previousPeriod = { start: '2026-10-01', end: '2026-10-31' };
  const previous = buildCity([repo], items, previousPeriod, previousPeriod.end, 'UTC');
  expect(previous.faces).toEqual(model.faces);
  expect(previous.labels[0].works).toBe(2);
  expect(previous.labels[0].count).toBe(1);
  expect(model.labels[0].count).toBe(3);
  expect(model.labels[0].stage).toBe('Primeiras obras');
  expect(
    Math.max(
      ...model.faces
        .filter((face) => face.repo === repo.id)
        .flatMap((face) => face.points.map((point) => point[2])),
    ),
  ).toBeLessThan(20);
  const standalone = { ...base, id: 'standalone', kind: 'commit' as const, associatedPullRequests: [] };
  expect(buildCity([repo], [...items, standalone], period, period.end, 'UTC').labels[0].works).toBe(3);
});
