import type { AppConfig, Repository } from './types';

/** One scope rule for storage projections and local token attribution. */
export function repositoryInScope(repo: Repository, config: AppConfig): boolean {
  let host = '';
  try {
    host = repo.url ? new URL(repo.url).hostname.toLowerCase() : '';
  } catch {
    return false;
  }
  if (repo.source === 'gitlab') {
    return (
      !!config.gitlab?.enabled &&
      config.gitlab.projects.includes(repo.fullName) &&
      host === config.gitlab.host.toLowerCase()
    );
  }
  if (repo.source === 'bitbucket') {
    return (
      !!config.bitbucket?.enabled &&
      host === 'bitbucket.org' &&
      config.bitbucket.repositories.some((name) => name.toLowerCase() === repo.fullName.toLowerCase())
    );
  }
  return (
    (!host || host === config.githubHost.toLowerCase()) &&
    config.organizations.some((org) => org.trim().toLowerCase() === repo.fullName.split('/')[0].toLowerCase())
  );
}
