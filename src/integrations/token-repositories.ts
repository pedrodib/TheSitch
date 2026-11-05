import path from 'node:path';
import { repositoryInScope } from '../shared/repositories';
import type { IntegrationContext } from '../shared/types';
import { run } from './cli';

/** Resolves local sessions without confusing equal repository names on different hosts. */
export function createRepositoryResolver(context: IntegrationContext) {
  const { config } = context;
  const cache = new Map<string, string | null | false>();
  return async (cwd: string): Promise<string | null | false> => {
    if (!cwd) return null;
    if (cache.has(cwd)) return cache.get(cwd) ?? null;
    const explicit = Object.entries(config.repoMappings)
      .filter(([key]) => {
        const relative = path.relative(key, cwd);
        return (
          relative === '' ||
          (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
        );
      })
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    let name = explicit || '';
    let host = '';
    if (!name) {
      try {
        const remote = (
          await run('git', ['config', '--get', 'remote.origin.url'], { cwd, timeout: 5000 })
        ).trim();
        const url = new URL(
          remote.includes('://') ? remote : remote.replace(/^([^@]+@)?([^:]+):/, 'ssh://$1$2/'),
        );
        host = url.hostname.toLowerCase();
        name = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
      } catch {
        /* Unavailable folders stay unassigned. */
      }
    }
    const candidates = context.repositories.filter((repo) => {
      if (repo.id === name) return true;
      if (repo.fullName.toLowerCase() !== name.toLowerCase()) return false;
      if (!host) return true;
      try {
        return new URL(repo.url).hostname.toLowerCase() === host;
      } catch {
        return false;
      }
    });
    const known = candidates.length === 1 ? candidates[0] : undefined;
    const configuredName =
      config.organizations.some(
        (org) =>
          name.toLowerCase().startsWith(`${org.toLowerCase()}/`) &&
          (!host || host === config.githubHost.toLowerCase()),
      ) ||
      (!!config.gitlab?.enabled &&
        config.gitlab.projects.includes(name) &&
        (!host || host === config.gitlab.host.toLowerCase())) ||
      (!!config.bitbucket?.enabled &&
        config.bitbucket.repositories.some((repo) => repo.toLowerCase() === name.toLowerCase()) &&
        (!host || host === 'bitbucket.org'));
    const result = known
      ? repositoryInScope(known, config)
        ? known.id
        : false
      : name.includes('/') && !configuredName
        ? false
        : null;
    cache.set(cwd, result);
    return result;
  };
}
