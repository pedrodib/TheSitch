import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBitbucket, collectGitlab } from '../src/integrations/forges';
import { defaultConfig } from '../src/shared/defaults';
import type { IntegrationContext } from '../src/shared/types';

vi.mock('../src/integrations/cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/integrations/cli')>()),
  run: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('secret'),
  stat: vi.fn().mockResolvedValue({ size: 6, mode: 0o600, isFile: () => true }),
}));

import { run } from '../src/integrations/cli';

function context(): IntegrationContext {
  const config = defaultConfig('/tmp');
  config.gitlab = {
    enabled: true,
    host: 'gitlab.com',
    projects: ['group/sub/repo'],
    cli: 'glab',
    username: 'alice',
  };
  config.bitbucket = {
    enabled: true,
    repositories: ['team/repo'],
    email: 'alice@example.com',
    tokenFile: '/tmp/token',
    accountId: 'account',
  };
  return {
    config,
    since: null,
    until: '2026-12-31T23:59:59.000Z',
    repositories: [],
    onProgress: vi.fn(),
    onBatch: vi.fn(),
    onStep: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe('forge imports', () => {
  it('verifies GitLab identity and imports authored merge requests in bounded pages', async () => {
    vi.mocked(run)
      .mockResolvedValueOnce(JSON.stringify({ username: 'Alice', email: 'alice@example.com' }))
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            iid: 4,
            title: 'Fix',
            state: 'merged',
            web_url: 'https://gitlab.com/group/sub/repo/-/merge_requests/4',
            created_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-02T00:00:00.000Z',
            merged_at: '2026-02-02T00:00:00.000Z',
          },
        ]),
      );
    vi.mocked(run).mockResolvedValueOnce('[]');
    const ctx = context();
    const result = await collectGitlab(ctx);
    expect(result.complete).toBe(true);
    expect(result.contributions[0]).toMatchObject({ source: 'gitlab', state: 'merged' });
    expect(vi.mocked(run).mock.calls[1][1].join(' ')).toContain('group%2Fsub%2Frepo');
    expect(ctx.onBatch).toHaveBeenCalledOnce();
  });
  it('rejects a mismatched GitLab account', async () => {
    vi.mocked(run).mockResolvedValueOnce(JSON.stringify({ username: 'other' }));
    const result = await collectGitlab(context());
    expect(result.complete).toBe(false);
    expect(result.contributions).toHaveLength(0);
  });
  it('matches Bitbucket author UUID and rejects cross-origin pagination without leaking credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uuid: '{user}', account_id: 'account' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              {
                id: 1,
                title: 'Mine',
                state: 'OPEN',
                author: { uuid: '{user}' },
                created_on: '2026-02-01T00:00:00.000Z',
                updated_on: '2026-02-02T00:00:00.000Z',
                links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/1' } },
              },
            ],
            next: 'https://evil.example/2.0/steal',
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context();
    const result = await collectBitbucket(ctx);
    expect(result.complete).toBe(false);
    expect(result.contributions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result.errors)).not.toContain('secret');
    expect(ctx.onBatch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

it('imports GitLab authored commits with associated merge requests', async () => {
  vi.mocked(run)
    .mockResolvedValueOnce(JSON.stringify({ username: 'alice', email: 'alice@example.com' }))
    .mockResolvedValueOnce('[]')
    .mockResolvedValueOnce(
      JSON.stringify([
        {
          id: 'abc',
          author_email: 'alice@example.com',
          authored_date: '2026-03-01T00:00:00Z',
          title: 'Commit',
          web_url: 'https://gitlab.com/commit/abc',
        },
      ]),
    )
    .mockResolvedValueOnce(JSON.stringify([{ iid: 42 }]));
  const result = await collectGitlab(context());
  expect(result.complete).toBe(true);
  expect(result.contributions[0]).toMatchObject({ kind: 'commit', associatedPullRequests: [42] });
});

it('imports Bitbucket merge timestamps and associates authored commits with pull requests', async () => {
  const pages = [
    { uuid: '{user}', account_id: 'account' },
    {
      values: [
        {
          id: 1,
          title: 'Merged',
          state: 'MERGED',
          author: { uuid: '{user}' },
          created_on: '2026-02-01T00:00:00Z',
          updated_on: '2026-03-03T00:00:00Z',
          links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/1' } },
        },
      ],
    },
    { values: [{ update: { state: 'MERGED', date: '2026-02-02T12:00:00Z' } }] },
    {
      values: [
        {
          hash: 'abc',
          message: 'Commit',
          date: '2026-02-01T00:00:00Z',
          author: { user: { uuid: '{user}' } },
        },
      ],
    },
    { values: [{ id: 1 }] },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(JSON.stringify(pages.shift()))),
  );
  const result = await collectBitbucket(context());
  expect(result.complete).toBe(true);
  expect(result.contributions).toMatchObject([
    { kind: 'pull_request', mergedAt: '2026-02-02T12:00:00Z' },
    { kind: 'commit', associatedPullRequests: [1] },
  ]);
  vi.unstubAllGlobals();
});

it('reuses completed GitLab request pages after an interrupted import', async () => {
  const cachedPages = new Map<string, unknown>();
  const ctx = context();
  ctx.request = async <T>(key: string, fetcher: () => Promise<T>) => {
    if (cachedPages.has(key)) return cachedPages.get(key) as T;
    const value = await fetcher();
    cachedPages.set(key, value);
    return value;
  };
  const user = JSON.stringify({ username: 'alice', email: 'alice@example.com' });
  vi.mocked(run)
    .mockResolvedValueOnce(user)
    .mockResolvedValueOnce('[]')
    .mockRejectedValueOnce(new Error('interrupted'));
  const first = await collectGitlab(ctx);
  expect(first.complete).toBe(false);
  vi.mocked(run).mockResolvedValueOnce(user).mockResolvedValueOnce('[]');
  const second = await collectGitlab(ctx);
  expect(second.complete).toBe(true);
  expect(vi.mocked(run)).toHaveBeenCalledTimes(5);
});

it('limits Bitbucket pull request queries to the requested update window and detects missing pages', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ uuid: '{user}', account_id: 'account' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ size: 2, pagelen: 100, values: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ values: [] })));
  vi.stubGlobal('fetch', fetchMock);
  const ctx = context();
  ctx.since = '2026-06-01T00:00:00.000Z';
  const result = await collectBitbucket(ctx);
  const url = new URL(fetchMock.mock.calls[1][0].toString());
  expect(url.searchParams.get('q')).toContain('updated_on >= 2026-06-01T00:00:00.000Z');
  expect(result.complete).toBe(false);
  expect(result.errors.some((error) => error.message.includes('Incomplete Bitbucket pagination'))).toBe(true);
  vi.unstubAllGlobals();
});

it('does not treat HTTP 202 association indexing as proof of an independent commit', async () => {
  const responses = [
    new Response(JSON.stringify({ uuid: '{user}', account_id: 'account' })),
    new Response(JSON.stringify({ values: [] })),
    new Response(
      JSON.stringify({
        values: [
          {
            hash: 'abc',
            message: 'Commit',
            date: '2026-03-01T00:00:00Z',
            author: { user: { uuid: '{user}' } },
          },
        ],
      }),
    ),
    new Response(JSON.stringify({ values: [] }), { status: 202 }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => responses.shift()),
  );
  try {
    const result = await collectBitbucket(context());
    expect(result.complete).toBe(false);
    expect(result.contributions).toHaveLength(0);
    expect(result.errors.some((e) => e.message.includes('Pull Request Commit Links'))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
