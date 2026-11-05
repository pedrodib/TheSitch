import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportJournal } from '../src/backend/import-history';
import { Store } from '../src/backend/store';
import { run as cli } from '../src/integrations/cli';
import { collectGithub } from '../src/integrations/github';
import { importLabel } from '../src/renderer/import-history';
import { defaultConfig } from '../src/shared/defaults';

vi.mock('../src/integrations/cli', async (original) => ({
  ...(await original<typeof import('../src/integrations/cli')>()),
  run: vi.fn(),
}));
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(cli).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sitch-resume-'));
  dirs.push(dir);
  const config = defaultConfig('/tmp');
  config.organizations = ['corp'];
  config.workspace.members[0].externalLogin = 'alice';
  const file = join(dir, 'test.sqlite');
  return { config, file, store: new Store(file, config) };
}
it('resumes a real GitHub collector after restart, skips completed years, and never duplicates rows', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-06-01T12:00:00Z'));
  const { config, file, store: first } = setup();
  let store = first;
  let journal = new ImportJournal(store);
  const importedAt = new Date().toISOString();
  const year = Number(importedAt.slice(0, 4));
  let fail = true;
  vi.mocked(cli).mockImplementation(async (_bin, args) => {
    const endpoint = args.at(-1) ?? '';
    if (endpoint.startsWith('orgs/'))
      return JSON.stringify([
        { id: 1, name: 'project', full_name: 'corp/project', html_url: 'https://github.com/corp/project' },
      ]);
    if (endpoint.startsWith('search/')) {
      const query = decodeURIComponent(endpoint);
      const number = query.includes(`created:${year}-01-01`)
        ? 1
        : query.includes(`created:${year - 1}-01-01`)
          ? 2
          : 0;
      const items =
        number && query.includes('author:alice') && !query.startsWith('search/commits')
          ? [
              {
                number,
                title: `PR ${number}`,
                html_url: `https://github.com/corp/project/pull/${number}`,
                created_at: `${year - number + 1}-01-01T12:00:00Z`,
                updated_at: `${year - number + 1}-01-01T12:00:00Z`,
                state: 'open',
                repository_url: 'https://api.github.com/repos/corp/project',
              },
            ]
          : [];
      return JSON.stringify({ total_count: items.length, incomplete_results: false, items });
    }
    if (endpoint === 'repos/corp/project/pulls/2' && fail) throw new Error('Sem conexão');
    if (endpoint.startsWith('repos/corp/project/pulls/'))
      return JSON.stringify({ additions: 1, deletions: 0 });
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  const execute = async () => {
    const attempt = journal.begin('github', false);
    const result = await collectGithub({
      config,
      since: attempt.since,
      until: attempt.until,
      repositories: store.getRepositories(),
      onProgress: () => {},
      onBatch: (batch) => store.importResult(batch),
      ...journal.context(
        attempt,
        () => true,
        new AbortController().signal,
        () => {},
      ),
    });
    store.importResult(result);
    journal.finish(
      attempt,
      result.complete,
      result.errors.map((e) => e.message),
      false,
    );
    return { attempt, result };
  };
  try {
    const firstAttempt = await execute();
    expect(firstAttempt.result.complete).toBe(false);
    expect(store.getContributions()).toHaveLength(1);
    expect(store.getCheckpoint('github')).toBeNull();
    expect(
      firstAttempt.attempt.steps.some(
        (step) => step.from === `${year}-01-01` && step.label.endsWith('PRs') && step.state === 'complete',
      ),
    ).toBe(true);
    const until = firstAttempt.attempt.until;
    store.close();
    store = new Store(file, config);
    journal = new ImportJournal(store);
    journal.recover();
    fail = false;
    const next = await execute();
    expect(next.attempt.until).toBe(until);
    expect(next.result.complete).toBe(true);
    expect(store.getContributions()).toHaveLength(2);
    expect(store.getCheckpoint('github')).toBe(until);
    const calls = vi.mocked(cli).mock.calls.map(([, args]) => decodeURIComponent(args.at(-1) ?? ''));
    expect(calls.filter((e) => e === 'repos/corp/project/pulls/1')).toHaveLength(1);
    expect(
      calls.filter(
        (e) =>
          e.startsWith('search/issues') && e.includes('author:alice') && e.includes(`created:${year}-01-01`),
      ),
    ).toHaveLength(1);
    const history = journal.history().sources.find((s) => s.source === 'github');
    expect(history?.historyComplete).toBe(true);
    expect(history?.stored.records).toBe(2);
    expect(history?.recent[0].state).toBe('failed');
    const delta = journal.begin('github', false);
    expect(delta.mode).toBe('delta');
    expect(delta.since).toBe(new Date(Date.parse(until) - 86400000).toISOString());
  } finally {
    store.close();
  }
});
it('retains last success on failure, marks crash interruption and does not call old data updated', async () => {
  const { store } = setup();
  const journal = new ImportJournal(store);
  try {
    const first = journal.begin('github', false);
    journal.finish(first, true, [], false);
    const checkpoint = store.getCheckpoint('github');
    const next = journal.begin('github', false);
    journal.finish(next, false, ['offline'], false);
    expect(store.getCheckpoint('github')).toBe(checkpoint);
    const source = journal.history().sources.find((s) => s.source === 'github');
    if (!source) throw Error('source absent');
    expect(importLabel(source, Date.now(), 10)).toBe('Com pendências');
    journal.begin('github', false);
    journal.recover();
    expect(journal.current('github')?.state).toBe('interrupted');
    source.run = first;
    source.checkedThrough = '2020-01-01T00:00:00Z';
    expect(importLabel(source, Date.now(), 10)).toBe('Precisa atualizar');
  } finally {
    store.close();
  }
});
it('does not cache partial search responses and isolates journals after scope changes', async () => {
  const { store, config } = setup();
  const journal = new ImportJournal(store);
  try {
    const run = journal.begin('github', false);
    const context = journal.context(
      run,
      () => true,
      new AbortController().signal,
      () => {},
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ incomplete_results: true, items: [] })
      .mockResolvedValue({ incomplete_results: false, items: [] });
    await expect(context.request?.('search/issues?q=x', fetch)).rejects.toThrow('incompletos');
    await context.request?.('search/issues?q=x', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    store.saveConfig({ ...config, organizations: ['different'] });
    expect(journal.current('github')).toBeNull();
    expect(store.getCheckpoint('github')).toBeNull();
  } finally {
    store.close();
  }
});

it('drops pre-2026 pending windows on resume while preserving completed work', () => {
  const { store } = setup();
  try {
    const journal = new ImportJournal(store);
    const run = journal.begin('github', true);
    run.state = 'interrupted';
    run.steps = [
      {
        id: '2026',
        label: 'PRs',
        from: '2026-01-01',
        to: '2026-11-05',
        processed: 3,
        total: 3,
        state: 'complete',
      },
      {
        id: '2025',
        label: 'PRs',
        from: '2025-01-01',
        to: '2025-12-31',
        processed: 0,
        total: null,
        state: 'pending',
      },
    ];
    journal.save(run);
    const resumed = journal.begin('github', false);
    expect(resumed.id).toBe(run.id);
    expect(resumed.steps.map((step) => step.id)).toEqual(['2026']);
    expect(resumed.steps[0].state).toBe('complete');
  } finally {
    store.close();
  }
});
