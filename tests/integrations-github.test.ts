import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/integrations/cli';
import { collectGithub } from '../src/integrations/github';
import { defaultConfig } from '../src/shared/defaults';

vi.mock('../src/integrations/cli', async (original) => ({
  ...(await original<typeof import('../src/integrations/cli')>()),
  run: vi.fn(),
  errorResult: (source: string, e: Error) => ({ source, message: e.message, at: '' }),
}));
const command = vi.mocked(run);
const repo = {
  id: 1,
  name: 'project',
  full_name: 'corp/project',
  html_url: 'https://github.com/corp/project',
  description: null,
};
const pr = {
  number: 7,
  title: 'Change',
  html_url: 'https://github.com/corp/project/pull/7',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2025-01-02T00:00:00Z',
  state: 'open',
  repository_url: 'https://api.github.com/repos/corp/project',
  labels: [],
};
const ctx = () => {
  const config = defaultConfig('/tmp');
  config.organizations = ['corp'];
  config.workspace.members[0].externalLogin = 'alice';
  return { config, since: '2025-01-01T00:00:00Z', repositories: [], onProgress: () => {} };
};
beforeEach(() => {
  command.mockReset();
  command.mockImplementation(async (_bin, args) => {
    const endpoint = args[args.length - 1];
    if (endpoint.startsWith('orgs/')) return JSON.stringify([repo]);
    if (endpoint.startsWith('search/commits'))
      return JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            sha: 'abc',
            repository: { full_name: 'corp/project' },
            html_url: 'https://example.test/commit',
            commit: { message: 'Commit', author: { date: '2025-01-01T00:00:00Z' } },
          },
        ],
      });
    if (endpoint.includes('/commits/abc/pulls')) return JSON.stringify([{ number: 7 }]);
    if (endpoint.startsWith('search/issues'))
      return JSON.stringify({ total_count: 1, incomplete_results: false, items: [pr] });
    if (endpoint.includes('/reviews?'))
      return JSON.stringify([
        { id: 4, user: { login: 'alice' }, submitted_at: '2025-01-02T00:00:00Z', state: 'APPROVED' },
      ]);
    if (endpoint.includes('/pulls/7')) return JSON.stringify({ additions: 3, deletions: 1 });
    throw Error('unexpected endpoint');
  });
});
describe('GitHub collection', () => {
  it('imports PRs before commits and preserves them if commit search fails', async () => {
    const previous = command.getMockImplementation();
    const batches = vi.fn();
    command.mockImplementation(async (bin, args, options) => {
      if (args.at(-1)?.startsWith('search/commits')) throw new Error('Commit search unavailable');
      if (!previous) throw new Error('Missing mock');
      return previous(bin, args, options);
    });
    const result = await collectGithub({ ...ctx(), onBatch: batches });
    expect(result.complete).toBe(false);
    expect(result.contributions.some((item) => item.kind === 'pull_request')).toBe(true);
    expect(
      batches.mock.calls
        .flatMap(([batch]) => batch.contributions)
        .some((item) => item.kind === 'pull_request'),
    ).toBe(true);
    const endpoints = command.mock.calls.map((call) => call[1].at(-1) || '');
    expect(endpoints.findIndex((endpoint) => endpoint.startsWith('search/issues'))).toBeLessThan(
      endpoints.findIndex((endpoint) => endpoint.startsWith('search/commits')),
    );
  });
  it('limits incremental searches and retains commits belonging to a PR without treating them as separate deliveries', async () => {
    const result = await collectGithub(ctx());
    expect(result.complete).toBe(true);
    expect(result.contributions.find((c) => c.kind === 'commit')?.associatedPullRequests).toEqual([7]);
    const calls = command.mock.calls.map((c) => decodeURIComponent(c[1].at(-1) || ''));
    expect(calls.find((c) => c.startsWith('search/commits'))).toContain('author-date:2026-01-01');
    expect(calls.find((c) => c.startsWith('search/issues'))).toContain('updated:2026-01-01..');
  });
  it('uses the submitted review timestamp and only includes contributed repositories', async () => {
    const result = await collectGithub(ctx());
    expect(result.contributions.find((c) => c.kind === 'review')?.occurredAt).toBe('2025-01-02T00:00:00Z');
    expect(result.repositories.map((r) => r.fullName)).toEqual(['corp/project']);
  });
  it('surfaces an incomplete search rather than marking coverage complete', async () => {
    command.mockImplementation(async (_bin, args) =>
      args.at(-1)?.startsWith('orgs/')
        ? JSON.stringify([repo])
        : JSON.stringify({ total_count: 0, incomplete_results: true, items: [] }),
    );
    const result = await collectGithub(ctx());
    expect(result.complete).toBe(false);
  });
});
it('requires a successful production deployment for deployed state', async () => {
  const previous = command.getMockImplementation();
  command.mockImplementation(async (bin, args, options) => {
    const endpoint = args.at(-1) || '';
    if (endpoint.includes('/deployments?')) return JSON.stringify([{ id: 1, environment: 'production' }]);
    if (endpoint.includes('/deployments/1/statuses'))
      return JSON.stringify([{ state: 'success', created_at: '2025-01-03T00:00:00Z' }]);
    if (endpoint.includes('/pulls/7') && !endpoint.includes('reviews'))
      return JSON.stringify({ merged_at: '2025-01-02T00:00:00Z', merge_commit_sha: 'abc' });
    if (!previous) throw new Error('Missing mock implementation');
    return previous(bin, args, options);
  });
  const result = await collectGithub(ctx());
  expect(result.contributions.find((c) => c.kind === 'pull_request')?.deployedAt).toBe(
    '2025-01-03T00:00:00Z',
  );
});

it('rejects missing search pages rather than completing a truncated import', async () => {
  command.mockImplementation(async (_bin, args) =>
    args.at(-1)?.startsWith('orgs/')
      ? JSON.stringify([repo])
      : JSON.stringify({ total_count: 2, incomplete_results: false, items: [pr] }),
  );
  const result = await collectGithub(ctx());
  expect(result.complete).toBe(false);
  expect(result.errors[0].message).toContain('paginação');
});
