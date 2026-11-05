import { describe, expect, it, vi } from 'vitest';
import { ImportJournal } from '../src/backend/import-history';
import { Store } from '../src/backend/store';
import { createRepositoryResolver } from '../src/integrations/token-repositories';
import { defaultConfig } from '../src/shared/defaults';
import { repositoryInScope } from '../src/shared/repositories';
import type { Repository } from '../src/shared/types';
import { validateConfig } from '../src/shared/validation';

vi.mock('../src/integrations/cli', () => ({ run: vi.fn(async () => 'git@gitlab.example:team/sub/api.git') }));
const config = () => ({
  ...defaultConfig('/tmp'),
  gitlab: {
    enabled: true,
    host: 'gitlab.example',
    projects: ['team/sub/api'],
    cli: 'glab',
    username: 'alice',
  },
  bitbucket: {
    enabled: true,
    repositories: ['team/api'],
    email: 'alice@example.com',
    tokenFile: '/tmp/token',
    accountId: '{abc}',
  },
});
const repo = (source: Repository['source'], host: string, name: string): Repository => ({
  id: `${source}:${host}:${name}`,
  source,
  workspaceId: 'local-workspace',
  name: name.split('/').at(-1) ?? '',
  fullName: name,
  url: `https://${host}/${name}`,
  description: '',
});
describe('multi-platform configuration and projections', () => {
  it('accepts GitLab and Bitbucket without any GitHub organizations or login, preserving legacy configurations', () => {
    expect(validateConfig({ ...config(), onboardingComplete: true }).gitlab?.enabled).toBe(true);
    const legacy = defaultConfig('/tmp');
    delete legacy.gitlab;
    delete legacy.bitbucket;
    expect(validateConfig(legacy).gitlab).toBeUndefined();
    expect(() => validateConfig({ ...config(), gitlab: { ...config().gitlab, projects: [] } })).toThrow();
    expect(() =>
      validateConfig({ ...config(), bitbucket: { ...config().bitbucket, tokenFile: 'secret-token' } }),
    ).toThrow();
  });
  it('separates hosts, nested GitLab paths, disabled providers and unknown repositories', () => {
    expect(repositoryInScope(repo('gitlab', 'gitlab.example', 'team/sub/api'), config())).toBe(true);
    expect(repositoryInScope(repo('gitlab', 'other.example', 'team/sub/api'), config())).toBe(false);
    expect(repositoryInScope(repo('bitbucket', 'bitbucket.org', 'team/api'), config())).toBe(true);
    expect(repositoryInScope(repo('bitbucket', 'evil.example', 'team/api'), config())).toBe(false);
    expect(repositoryInScope(repo('github', 'github.com', 'team/api'), config())).toBe(false);
  });
  it('keeps independent history checkpoints and hides disabled provider data without deleting it', () => {
    const store = new Store(':memory:', config());
    try {
      const repositories = [
        repo('gitlab', 'gitlab.example', 'team/sub/api'),
        repo('bitbucket', 'bitbucket.org', 'team/api'),
      ];
      store.importResult({
        repositories,
        contributions: [],
        tokens: [],
        errors: [],
        complete: true,
        coverageStart: null,
      });
      const journal = new ImportJournal(store);
      journal.finish(journal.begin('gitlab', false), true, [], false);
      journal.finish(journal.begin('bitbucket', false), false, ['Offline'], false);
      expect(journal.history().sources.find((s) => s.source === 'gitlab')?.historyComplete).toBe(true);
      expect(journal.history().sources.find((s) => s.source === 'bitbucket')?.historyComplete).toBe(false);
      expect(store.getRepositories()).toHaveLength(2);
      store.saveConfig({ ...config(), gitlab: { ...config().gitlab, enabled: false } });
      expect(store.getRepositories().map((r) => r.source)).toEqual(['bitbucket']);
      expect(store.getCheckpoint('gitlab')).toBeNull();
      store.saveConfig(config());
      expect(store.getRepositories()).toHaveLength(2);
    } finally {
      store.close();
    }
  });
  it('attributes a nested GitLab SSH remote and rejects ambiguous manual mappings', async () => {
    const repositories = [
      repo('gitlab', 'gitlab.example', 'team/sub/api'),
      repo('github', 'github.com', 'team/sub/api'),
    ];
    const context = { config: config(), repositories, since: null, onProgress: () => {} };
    expect(await createRepositoryResolver(context)('/work')).toBe(repositories[0].id);
    context.config.repoMappings['/manual'] = 'team/sub/api';
    expect(await createRepositoryResolver(context)('/manual')).toBeNull();
    context.config.repoMappings['/manual'] = repositories[0].id;
    expect(await createRepositoryResolver(context)('/manual')).toBe(repositories[0].id);
  });
});
