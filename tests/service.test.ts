import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  github: vi.fn(),
  gitlab: vi.fn(),
  bitbucket: vi.fn(),
  codex: vi.fn(),
  claude: vi.fn(),
  azure: vi.fn(),
  holidays: vi.fn(),
  luna: vi.fn(),
}));
vi.mock('../src/integrations/forges', () => ({
  collectGitlab: mocks.gitlab,
  collectBitbucket: mocks.bitbucket,
  diagnoseForges: vi.fn(async () => []),
}));
vi.mock('../src/integrations', () => ({
  collectGithub: mocks.github,
  collectCodex: mocks.codex,
  collectClaude: mocks.claude,
  collectAzure: mocks.azure,
  fetchNationalHolidays: mocks.holidays,
  analyzeWithLuna: mocks.luna,
  diagnose: vi.fn(),
  discoverGithub: vi.fn(),
}));

import { AppService } from '../src/main/service';
import type { Assessment, Contribution, ImportResult, IntegrationContext } from '../src/shared/types';

let dir: string;
let app: AppService;
const empty = (): ImportResult => ({
  repositories: [],
  contributions: [],
  tokens: [],
  errors: [],
  complete: true,
  coverageStart: '2026-01-01',
});
const record: Contribution = {
  id: 'pr',
  workspaceId: 'local-workspace',
  memberId: 'local-member',
  repositoryId: 'repo',
  source: 'github',
  externalId: '1',
  kind: 'pull_request',
  title: 'Entrega',
  body: '',
  url: '',
  occurredAt: '2026-10-05T15:00:00Z',
  updatedAt: '2026-10-05T15:00:00Z',
  state: 'merged',
  additions: 1,
  deletions: 0,
  participants: ['local-member'],
  labels: [],
};
const period = { start: '2026-10-01', end: '2026-10-31' };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sitch-service-'));
  delete process.env.THESITCH_DEMO;
  mocks.github.mockReset().mockResolvedValue({
    ...empty(),
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
    contributions: [record],
  });
  mocks.gitlab.mockReset().mockResolvedValue(empty());
  mocks.bitbucket.mockReset().mockResolvedValue(empty());
  mocks.codex.mockReset().mockResolvedValue(empty());
  mocks.claude.mockReset().mockResolvedValue(empty());
  mocks.azure.mockReset().mockResolvedValue(empty());
  mocks.holidays.mockReset().mockResolvedValue({ '2026-10-06': 'Feriado' });
  mocks.luna.mockReset();
  app = new AppService(dir, '/tmp', () => {});
});
afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
function configure() {
  const c = app.getConfig();
  c.organizations = ['org'];
  c.workspace.members[0].externalLogin = 'alice';
  c.onboardingComplete = true;
  return app.saveConfig(c);
}

describe('AppService', () => {
  it('syncs both local token sources and gives Claude an independent incremental checkpoint', async () => {
    configure();
    mocks.claude.mockResolvedValue({
      ...empty(),
      tokens: [
        {
          id: 'claude:one',
          provider: 'claude',
          workspaceId: 'local-workspace',
          memberId: 'local-member',
          sessionId: 'session',
          repositoryId: null,
          occurredAt: '2026-10-05T15:00:00Z',
          input: 32,
          cached: 20,
          cacheWrite: 10,
          output: 5,
          total: 37,
          model: 'claude-test',
          isTheSitch: false,
        },
      ],
    });
    await app.sync();
    expect(app.getDashboard(period).metrics.tokensByProvider.claude).toBe(37);
    expect(app.store.getCheckpoint('claude')).not.toBeNull();
    await app.sync();
    expect(mocks.claude.mock.lastCall?.[0].since).not.toBeNull();
    expect(app.getDashboard(period).metrics.unassignedTokens).toBe(37);
  });
  it('persists batches before the full import finishes without declaring complete coverage', async () => {
    configure();
    const batch = await mocks.github();
    const gate: { finish?: (result: ImportResult) => void } = {};
    mocks.github.mockImplementationOnce((context: IntegrationContext) => {
      context.onBatch?.(batch);
      context.onProgress('Importados alguns PRs');
      return new Promise<ImportResult>((resolve) => {
        gate.finish = resolve;
      });
    });
    const syncing = app.sync();
    await vi.waitFor(() => expect(gate.finish).toBeDefined());
    expect(app.getDashboard(period).metrics.deliveries).toBe(1);
    expect(app.store.getStatus().running).toBe(true);
    expect(app.store.getStatus().coverageComplete).toBe(false);
    expect(app.store.getCheckpoint('github')).toBeNull();
    gate.finish?.({ ...empty(), complete: false });
    await syncing;
    expect(app.store.getContributions()).toHaveLength(1);
    expect(app.store.getStatus().coverageComplete).toBe(false);
  });
  it('saves during collection, discards obsolete results and restarts with the new sources', async () => {
    const before = configure();
    before.calendar.automaticHolidays = false;
    app.saveConfig(before);
    const gate: { finish?: (result: ImportResult) => void } = {};
    const staleResult = await mocks.github();
    mocks.github
      .mockClear()
      .mockResolvedValue(empty())
      .mockImplementationOnce(
        () =>
          new Promise<ImportResult>((resolve) => {
            gate.finish = resolve;
          }),
      );
    const syncing = app.sync();
    await vi.waitFor(() => expect(gate.finish).toBeDefined());
    const next = app.getConfig();
    next.organizations = ['another-org'];
    next.workspace.name = 'Cidade atualizada';
    expect(app.saveConfig(next).workspace.name).toBe('Cidade atualizada');
    gate.finish?.(staleResult);
    await syncing;
    await vi.waitFor(() => expect(app.store.getStatus().running).toBe(false));
    expect(mocks.github).toHaveBeenCalledTimes(2);
    expect(mocks.github.mock.lastCall?.[0].config.organizations).toEqual(['another-org']);
    expect(app.store.getStatus().errors).toEqual([]);
    app.saveConfig(before);
    expect(app.store.getContributions()).toEqual([]);
  });
  it('does not overwrite a save with an older holiday request', async () => {
    configure();
    const gate: { finish?: (holidays: Record<string, string>) => void } = {};
    mocks.holidays.mockImplementationOnce(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          gate.finish = resolve;
        }),
    );
    const syncing = app.sync();
    await vi.waitFor(() => expect(gate.finish).toBeDefined());
    const next = app.getConfig();
    next.workspace.name = 'Nome salvo durante a coleta';
    next.calendar.automaticHolidays = false;
    app.saveConfig(next);
    gate.finish?.({ '2026-01-01': 'Resposta antiga' });
    await syncing;
    await vi.waitFor(() => expect(app.store.getStatus().running).toBe(false));
    expect(app.getConfig().workspace.name).toBe(next.workspace.name);
    expect(app.getConfig().calendar.automaticHolidays).toBe(false);
    expect(app.getConfig().calendar.automaticHolidayDates).toBeUndefined();
  });
  it('saves during an assessment and keeps its token cost in the original workspace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    configure();
    await app.sync();
    const before = app.getConfig();
    before.analysis.enabled = true;
    app.saveConfig(before);
    const gate: { finish?: (value: Assessment) => void } = {};
    mocks.luna.mockImplementationOnce(
      () =>
        new Promise<Assessment>((resolve) => {
          gate.finish = resolve;
        }),
    );
    const analysis = app.analyze(period);
    const next = app.getConfig();
    next.workspace.id = 'another-workspace';
    next.workspace.members[0].externalLogin = 'bob';
    app.saveConfig(next);
    const assessment: Assessment = {
      headline: 'Análise antiga',
      summary: 'Antiga',
      caveat: '',
      priority: '',
      rhythm: 'usual',
      confidence: 'low',
      evidenceIds: ['pr'],
      source: 'luna',
      provisional: false,
      usage: { input: 100, cached: 20, output: 50, total: 150 },
    };
    gate.finish?.(assessment);
    await analysis;
    expect(app.getDashboard(period).metrics.analysisTokens).toBe(0);
    app.saveConfig(before);
    expect(app.getDashboard(period).metrics.analysisTokens).toBe(150);
    expect(app.getDashboard(period).assessment.source).not.toBe('luna');
    mocks.luna.mockResolvedValue(assessment);
    await app.analyze(period);
    expect(app.getDashboard(period).metrics.analysisTokens).toBe(300);
  });
  it('reimports all history on request even after a successful incremental checkpoint', async () => {
    configure();
    await app.sync();
    await app.sync();
    expect(mocks.github.mock.lastCall?.[0].since).not.toBeNull();
    await app.sync(true);
    expect(mocks.github.mock.lastCall?.[0].since).toBeNull();
    expect(app.store.getContributions()).toHaveLength(1);
  });
  it('persists configuration and synced records across restart', async () => {
    configure();
    await app.sync();
    expect(app.getDashboard(period).metrics.deliveries).toBe(1);
    expect(app.getConfig().calendar.automaticHolidayDates?.['2026-10-06']).toBe('Feriado');
    app.close();
    app = new AppService(dir, '/tmp', () => {});
    expect(app.getConfig().workspace.members[0].externalLogin).toBe('alice');
    expect(app.getDashboard(period).metrics.deliveries).toBe(1);
    expect(app.store.getStatus().running).toBe(false);
  });
  it('rejects malformed configuration and invalid calendar values without persisting them', () => {
    const before = app.getConfig();
    const invalid = app.getConfig();
    invalid.calendar.timezone = 'invalid-zone';
    expect(() => app.saveConfig(invalid)).toThrow();
    expect(app.getConfig()).toEqual(before);
    expect(() => app.getDashboard({ start: '2026-02-30', end: '2026-03-01' })).toThrow();
  });
  it('keeps demo data separate from the persistent store', async () => {
    configure();
    await app.sync();
    app.setDemo(true);
    expect(app.getDashboard(period).demo).toBe(true);
    expect(app.store.getContributions()).toHaveLength(1);
    app.close();
    app = new AppService(dir, '/tmp', () => {});
    expect(app.getDashboard(period).demo).toBe(false);
    expect(app.getDashboard(period).contributions.map((c) => c.id)).toEqual(['pr']);
  });
  it('hides excluded organizations and rejects changing identity within a workspace', async () => {
    configure();
    await app.sync();
    const next = app.getConfig();
    next.organizations = [];
    app.saveConfig(next);
    expect(app.getDashboard(period).contributions).toEqual([]);
    expect(app.store.getCheckpoint('github')).toBeNull();
    next.workspace.members[0].externalLogin = 'bob';
    expect(() => app.saveConfig(next)).toThrow();
  });
  it('does not fetch automatic holidays when disabled', async () => {
    const next = configure();
    next.calendar.automaticHolidays = false;
    app.saveConfig(next);
    await app.sync();
    expect(mocks.holidays).not.toHaveBeenCalled();
  });
  it('preserves a pause requested while a source is still collecting', async () => {
    const next = configure();
    next.azure.enabled = true;
    app.saveConfig(next);
    const gate: { finish?: (value: ImportResult) => void } = {};
    mocks.github.mockImplementation(
      () =>
        new Promise<ImportResult>((resolve) => {
          gate.finish = resolve;
        }),
    );
    const syncing = app.sync();
    await vi.waitFor(() => expect(gate.finish).toBeDefined());
    app.setPaused(true);
    gate.finish?.(empty());
    const status = await syncing;
    expect(status.paused).toBe(true);
    expect(mocks.codex).toHaveBeenCalledOnce();
    expect(mocks.claude).toHaveBeenCalledOnce();
    expect(mocks.azure).not.toHaveBeenCalled();
  });
  it('caches analyses without re-triggering them because of their own token usage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    configure();
    await app.sync();
    const next = app.getConfig();
    next.analysis.enabled = true;
    app.saveConfig(next);
    mocks.luna.mockReset().mockResolvedValue({
      headline: 'A cidade avança',
      summary: 'Uma entrega observada.',
      caveat: 'Impacto não medido.',
      priority: 'Acompanhar o resultado.',
      rhythm: 'above',
      confidence: 'low',
      evidenceIds: ['pr'],
      source: 'luna',
      provisional: false,
      usage: { input: 100, cached: 20, output: 50, total: 150 },
    });
    const first = await app.analyze(period);
    const second = await app.analyze(period);
    expect(first).toEqual(second);
    expect(first.rhythm).toBe('insufficient');
    expect(mocks.luna).toHaveBeenCalledOnce();
    expect(app.getDashboard(period).metrics.analysisTokens).toBe(150);
    expect(app.getDashboard(period).metrics.tokens).toBe(0);
  });
});

it('uses a delta after restart instead of silently restarting full history', async () => {
  configure();
  await app.sync();
  const checkpoint = app.store.getCheckpoint('github');
  app.close();
  app = new AppService(dir, '/tmp', () => {});
  await app.sync();
  expect(mocks.github.mock.lastCall?.[0].since).toBe(
    new Date(Date.parse(checkpoint ?? '') - 86400000).toISOString(),
  );
  expect(app.getImportHistory().sources.find((s) => s.source === 'github')?.run?.mode).toBe('delta');
});
it('never marks a failed attempt as a new successful sync', async () => {
  configure();
  await app.sync();
  const last = app.store.getStatus().lastSync;
  const checkpoint = app.store.getCheckpoint('github');
  mocks.github.mockResolvedValue({
    ...empty(),
    complete: false,
    errors: [{ source: 'github', message: 'offline', at: new Date().toISOString() }],
  });
  await app.sync();
  expect(app.store.getStatus().lastSync).toBe(last);
  expect(app.store.getCheckpoint('github')).toBe(checkpoint);
  expect(app.getImportHistory().sources.find((s) => s.source === 'github')?.run?.state).toBe('failed');
});

it('imports GitLab without GitHub setup, projects it to metrics and resumes an independent delta', async () => {
  const config = app.getConfig();
  config.organizations = [];
  config.gitlab = {
    enabled: true,
    host: 'gitlab.com',
    projects: ['alice/app'],
    cli: 'glab',
    username: 'alice',
  };
  config.calendar.automaticHolidays = false;
  config.onboardingComplete = true;
  app.saveConfig(config);
  mocks.gitlab.mockResolvedValue({
    ...empty(),
    repositories: [
      {
        id: 'gl-repo',
        source: 'gitlab',
        workspaceId: config.workspace.id,
        name: 'app',
        fullName: 'alice/app',
        url: 'https://gitlab.com/alice/app',
        description: '',
      },
    ],
    contributions: [{ ...record, id: 'gl-pr', source: 'gitlab', repositoryId: 'gl-repo' }],
  });
  await app.sync();
  expect(mocks.github).not.toHaveBeenCalled();
  expect(app.getDashboard(period).metrics.deliveries).toBe(1);
  expect(app.store.getStatus().coverageComplete).toBe(true);
  expect(app.getImportHistory().sources.find((s) => s.source === 'gitlab')?.historyComplete).toBe(true);
  await app.sync();
  expect(mocks.gitlab.mock.lastCall?.[0].since).not.toBeNull();
  expect(() => app.saveConfig({ ...config, gitlab: { ...config.gitlab, username: 'another' } })).toThrow(
    'workspace',
  );
});

it('does not claim complete coverage if Bitbucket import remains pending alongside GitLab', async () => {
  const config = app.getConfig();
  config.organizations = [];
  config.onboardingComplete = true;
  config.calendar.automaticHolidays = false;
  config.gitlab = {
    enabled: true,
    host: 'gitlab.com',
    projects: ['alice/app'],
    cli: 'glab',
    username: 'alice',
  };
  config.bitbucket = {
    enabled: true,
    repositories: ['alice/app'],
    email: 'alice@example.com',
    tokenFile: '/tmp/token',
    accountId: '{alice}',
  };
  app.saveConfig(config);
  mocks.bitbucket.mockResolvedValue({
    ...empty(),
    complete: false,
    errors: [{ source: 'bitbucket', message: 'Rate limited', at: new Date().toISOString() }],
  });
  await app.sync();
  expect(app.store.getStatus().coverageComplete).toBe(false);
  expect(app.store.getCheckpoint('bitbucket')).toBeNull();
  expect(app.getImportHistory().sources.find((s) => s.source === 'bitbucket')?.run?.state).toBe('failed');
});
