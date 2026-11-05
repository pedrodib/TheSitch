import { HISTORY_START } from '../shared/defaults';
import type {
  AppConfig,
  Contribution,
  Discovery,
  ImportResult,
  ImportStep,
  IntegrationContext,
  Repository,
} from '../shared/types';
import { errorResult } from './cli';
import { createGithubApi, type GithubApi } from './github-api';
export async function discoverGithub(config: AppConfig): Promise<Discovery> {
  const api = createGithubApi(config);
  const user = (await api('user')) as { login: string };
  const orgs: string[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows = (await api(`user/orgs?per_page=100&page=${page}`)) as { login: string }[];
    orgs.push(...rows.map((row) => row.login));
    if (rows.length < 100) break;
  }
  return { login: user.login, organizations: orgs };
}
type SearchItem = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  state: string;
  user?: { login: string };
  repository_url: string;
  pull_request?: { merged_at?: string | null };
  labels?: { name: string }[];
};
async function search(api: GithubApi, query: string, start: Date, end: Date): Promise<SearchItem[]> {
  const window = `${query} created:${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
  const page = async (n: number) =>
    api(
      `search/issues?q=${encodeURIComponent(window)}&per_page=100&page=${n}&sort=created&order=asc`,
    ) as Promise<{
      total_count: number;
      incomplete_results: boolean;
      items: SearchItem[];
    }>;
  const first = await page(1);
  if (first.incomplete_results) throw new Error('GitHub search returned incomplete results');
  if (first.total_count > 1000) {
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000);
    if (days < 1) throw new Error('GitHub search exceeded its daily result limit');
    const mid = new Date(start.getTime() + Math.floor(days / 2) * 86400000);
    const next = new Date(mid.getTime() + 86400000);
    return [...(await search(api, query, start, mid)), ...(await search(api, query, next, end))];
  }
  const result = [...first.items];
  for (let p = 2; p <= Math.ceil(first.total_count / 100); p++) {
    const data = await page(p);
    if (data.incomplete_results) throw new Error('GitHub search returned incomplete results');
    result.push(...data.items);
  }
  if (
    result.length !== first.total_count ||
    new Set(result.map((r) => r.html_url)).size !== first.total_count
  )
    throw new Error('A paginação da busca de PRs mudou ou ficou incompleta. Será conferida novamente.');
  return result;
}
type Commit = {
  sha: string;
  html_url: string;
  repository: { full_name: string };
  commit: { message: string; author: { date: string } };
};
async function searchCommits(api: GithubApi, query: string, start: Date, end: Date): Promise<Commit[]> {
  const q = `${query} author-date:${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
  const page = async (n: number) =>
    api(
      `search/commits?q=${encodeURIComponent(q)}&per_page=100&page=${n}&sort=author-date&order=asc`,
    ) as Promise<{
      total_count: number;
      incomplete_results: boolean;
      items: Commit[];
    }>;
  const first = await page(1);
  if (first.incomplete_results) throw new Error('GitHub commit search returned incomplete results');
  if (first.total_count > 1000) {
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000);
    if (days < 1) throw new Error('GitHub commit search exceeded its daily result limit');
    const mid = new Date(start.getTime() + Math.floor(days / 2) * 86400000);
    return [
      ...(await searchCommits(api, query, start, mid)),
      ...(await searchCommits(api, query, new Date(mid.getTime() + 86400000), end)),
    ];
  }
  const rows = [...first.items];
  for (let p = 2; p <= Math.ceil(first.total_count / 100); p++) {
    const batch = await page(p);
    if (batch.incomplete_results) throw new Error('GitHub commit search returned incomplete results');
    rows.push(...batch.items);
  }
  if (
    rows.length !== first.total_count ||
    new Set(rows.map((r) => `${r.repository.full_name}:${r.sha}`)).size !== first.total_count
  )
    throw new Error('A paginação de commits mudou ou ficou incompleta. Será conferida novamente.');
  return rows;
}
export async function collectGithub(context: IntegrationContext): Promise<ImportResult> {
  context = {
    ...context,
    since: context.since && context.since < HISTORY_START ? HISTORY_START : context.since,
  };
  const { config } = context;
  const remote = createGithubApi(config, context.onProgress, context.signal, context.onWait);
  const api: GithubApi = (endpoint) =>
    context.request ? context.request(endpoint, () => remote(endpoint)) : remote(endpoint);
  const until = context.until ?? new Date().toISOString();
  const windows = () => {
    if (context.since)
      return [
        {
          from: (context.since < HISTORY_START ? HISTORY_START : context.since).slice(0, 10),
          to: until.slice(0, 10),
        },
      ];
    const result: { from: string; to: string }[] = [];
    for (let year = Number(until.slice(0, 4)); year >= Number(HISTORY_START.slice(0, 4)); year--)
      result.push({
        from: `${year}-01-01`,
        to: year === Number(until.slice(0, 4)) ? until.slice(0, 10) : `${year}-12-31`,
      });
    return result;
  };
  const done = new Map((context.completedSteps ?? []).map((step) => [step.id, step]));
  const steps = new Map<string, ImportStep>();
  const update = (id: string, changes: Partial<ImportStep>) => {
    const step = steps.get(id);
    if (step) {
      Object.assign(step, changes);
      context.onStep?.({ ...step });
    }
  };
  for (const org of config.organizations) {
    for (const member of config.workspace.members.filter((m) => m.externalLogin)) {
      for (const [kind, label] of [
        ['pull_request', 'PRs'],
        ['review', 'Revisões'],
        ['commit', 'Commits'],
      ]) {
        for (const window of windows()) {
          const id = `${org}:${member.id}:${kind}:${window.from}`;
          const step: ImportStep = {
            id,
            label: `${org} / ${member.externalLogin} / ${label}`,
            from: window.from,
            to: window.to,
            processed: 0,
            total: null,
            state: 'pending',
          };
          const saved = done.get(id) ?? step;
          steps.set(id, saved);
          context.onStep?.(saved);
        }
      }
    }
  }
  const result: ImportResult = {
    repositories: [],
    contributions: [],
    tokens: [],
    errors: [],
    complete: true,
    coverageStart: null,
  };
  const repos = new Map<string, Repository>();
  const contributions = new Map<string, Contribution>();
  let pending: Contribution[] = [];
  const publish = () => {
    if (!context.onBatch || !pending.length) return;
    const ids = new Set(pending.map((item) => item.repositoryId));
    context.onBatch({
      repositories: [...repos.values()].filter((repo) => ids.has(repo.id)),
      contributions: pending,
      tokens: [],
      errors: [],
      complete: false,
      coverageStart: null,
    });
    pending = [];
    context.onProgress(`GitHub: ${contributions.size} contribuições importadas. Buscando as próximas…`);
  };
  const track = (item: Contribution) => {
    contributions.set(item.id, item);
    if (context.onBatch) {
      pending.push(item);
      if (pending.length >= (context.onStep ? 1 : 25)) publish();
    }
  };
  for (const org of config.organizations) {
    try {
      context.onProgress(`GitHub: ${org}`);
      for (let p = 1; p <= 100; p++) {
        const rows = (await api(`orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&page=${p}`)) as {
          id: number;
          name: string;
          full_name: string;
          html_url: string;
          description: string | null;
        }[];
        for (const row of rows)
          repos.set(row.full_name.toLowerCase(), {
            id: `github:${config.githubHost}:${row.id}`,
            workspaceId: config.workspace.id,
            name: row.name,
            fullName: row.full_name,
            url: row.html_url,
            description: row.description || '',
          });
        if (rows.length < 100) break;
        if (p === 100) throw new Error('Inventário de repositórios excedeu a paginação segura.');
      }
      for (const member of config.workspace.members.filter((m) => m.externalLogin)) {
        for (const [kind, qualifier] of [
          ['pull_request', `author:${member.externalLogin}`],
          ['review', `reviewed-by:${member.externalLogin}`],
        ] as const) {
          for (const window of windows()) {
            const stepId = `${org}:${member.id}:${kind}:${window.from}`;
            if (done.has(stepId)) continue;
            update(stepId, { state: 'running', detail: 'Descobrindo total e páginas' });
            const items = await search(
              api,
              `is:pr org:${org} ${qualifier}${context.since ? ` updated:${context.since.slice(0, 10)}..${until.slice(0, 10)}` : ''}`,
              new Date(context.since ? HISTORY_START : window.from),
              new Date(window.to),
            );
            update(stepId, { total: items.length, detail: 'Conferindo detalhes e gravando' });
            let processed = 0;
            for (const item of items) {
              context.signal?.throwIfAborted();
              const full = item.repository_url.split('/').slice(-2).join('/').toLowerCase();
              const repo = repos.get(full);
              if (!repo) throw new Error(`Repositório ${full} indisponível no inventário; etapa incompleta.`);
              const detail = (await api(`repos/${full}/pulls/${item.number}`)) as {
                merged_at?: string | null;
                additions?: number;
                deletions?: number;
                merge_commit_sha?: string | null;
                requested_reviewers?: unknown[];
                requested_teams?: unknown[];
              };
              let deployedAt: string | undefined;
              if (kind === 'pull_request' && detail.merged_at && detail.merge_commit_sha) {
                for (let page = 1; page <= 100; page++) {
                  const deployments = (await api(
                    `repos/${full}/deployments?sha=${encodeURIComponent(detail.merge_commit_sha)}&per_page=100&page=${page}`,
                  )) as { id: number; environment?: string }[];
                  for (const deployment of deployments) {
                    if (!/^(production|prod)$/i.test(deployment.environment || '')) continue;
                    const statuses: { state: string; created_at: string; environment?: string }[] = [];
                    for (let statusPage = 1; statusPage <= 100; statusPage++) {
                      const batch = (await api(
                        `repos/${full}/deployments/${deployment.id}/statuses?per_page=100&page=${statusPage}`,
                      )) as typeof statuses;
                      statuses.push(...batch);
                      if (batch.length < 100) break;
                      if (statusPage === 100)
                        throw new Error('Status de deployments excederam a paginação segura.');
                    }
                    const successful = statuses.find(
                      (status) =>
                        status.state === 'success' &&
                        (!status.environment || /^(production|prod)$/i.test(status.environment)),
                    );
                    if (successful && (!deployedAt || successful.created_at < deployedAt))
                      deployedAt = successful.created_at;
                  }
                  if (deployments.length < 100) break;
                  if (page === 100) throw new Error('Deployments excederam a paginação segura.');
                }
              }
              let occurredAt = item.created_at;
              if (kind === 'review') {
                const reviews: {
                  id: number;
                  user?: { login: string };
                  submitted_at?: string;
                  state: string;
                }[] = [];
                for (let page = 1; page <= 100; page++) {
                  const batch = (await api(
                    `repos/${full}/pulls/${item.number}/reviews?per_page=100&page=${page}`,
                  )) as typeof reviews;
                  reviews.push(...batch);
                  if (batch.length < 100) break;
                  if (page === 100) throw new Error('Revisões excederam a paginação segura.');
                }
                const matching = reviews.filter(
                  (r) =>
                    r.user?.login.toLowerCase() === member.externalLogin.toLowerCase() &&
                    r.submitted_at &&
                    r.state !== 'PENDING',
                );
                if (!matching.length)
                  throw new Error(
                    'Revisão encontrada na busca sem detalhes correspondentes; etapa incompleta.',
                  );
                occurredAt = matching[0].submitted_at as string;
              }
              const id = `github:${kind}:${full}:${item.number}:${member.id}`;
              track({
                id,
                workspaceId: config.workspace.id,
                memberId: member.id,
                repositoryId: repo.id,
                source: 'github',
                externalId: `${config.githubHost}:${full}#${item.number}${kind === 'review' ? `:review:${member.externalLogin.toLowerCase()}` : ''}`,
                kind,
                title: item.title,
                body: item.body || '',
                url: item.html_url,
                occurredAt,
                updatedAt: item.updated_at,
                state: deployedAt
                  ? 'deployed'
                  : detail.merged_at
                    ? 'merged'
                    : item.state === 'closed'
                      ? 'closed'
                      : detail.requested_reviewers?.length || detail.requested_teams?.length
                        ? 'inspection'
                        : 'building',
                ...(deployedAt ? { deployedAt } : {}),
                ...(detail.merged_at ? { mergedAt: detail.merged_at } : {}),
                additions: detail.additions || 0,
                deletions: detail.deletions || 0,
                participants: [member.id],
                ...(config.azure.enabled && item.body?.match(/\bAB#(\d+)\b/i)
                  ? {
                      linkedWorkItem: `azure:${config.azure.organization.replace(/\/$/, '').toLowerCase()}:${item.body.match(/\bAB#(\d+)\b/i)?.[1]}`,
                    }
                  : {}),
                labels: (item.labels || []).map((l) => l.name),
              });
              update(stepId, { processed: ++processed, detail: `${repo.fullName} #${item.number}` });
            }
            publish();
            update(stepId, { state: 'complete', detail: 'Dados gravados' });
          }
        }
        for (const window of windows()) {
          const commitStep = `${org}:${member.id}:commit:${window.from}`;
          if (done.has(commitStep)) continue;
          update(commitStep, { state: 'running', detail: 'Descobrindo total e páginas' });
          const commits = await searchCommits(
            api,
            `org:${org} author:${member.externalLogin}`,
            new Date(window.from),
            new Date(window.to),
          );
          update(commitStep, { total: commits.length, detail: 'Conferindo vínculos com PRs' });
          let processedCommits = 0;
          for (const commit of commits) {
            context.signal?.throwIfAborted();
            const repo = repos.get(commit.repository.full_name.toLowerCase());
            if (!repo)
              throw new Error(`Repositório ${commit.repository.full_name} indisponível no inventário.`);
            const associated: { number: number }[] = [];
            for (let page = 1; page <= 100; page++) {
              const batch = (await api(
                `repos/${repo.fullName}/commits/${encodeURIComponent(commit.sha)}/pulls?per_page=100&page=${page}`,
              )) as { number: number }[];
              associated.push(...batch);
              if (batch.length < 100) break;
              if (page === 100) throw new Error('Vínculos do commit excederam a paginação segura.');
            }
            const id = `github:commit:${repo.id}:${commit.sha}:${member.id}`;
            track({
              id,
              workspaceId: config.workspace.id,
              memberId: member.id,
              repositoryId: repo.id,
              source: 'github',
              externalId: `${config.githubHost}:${repo.fullName}@${commit.sha}`,
              kind: 'commit',
              associatedPullRequests: associated.map((pr) => pr.number),
              title: commit.commit.message.split('\n')[0],
              body: '',
              url: commit.html_url,
              occurredAt: commit.commit.author.date,
              updatedAt: commit.commit.author.date,
              state: 'merged',
              additions: 0,
              deletions: 0,
              participants: [member.id],
              labels: [],
            });
            update(commitStep, {
              processed: ++processedCommits,
              detail: `${repo.fullName} ${commit.sha.slice(0, 8)}`,
            });
          }
          publish();
          update(commitStep, { state: 'complete', detail: 'Dados gravados' });
        }
      }
    } catch (error) {
      publish();
      if (context.signal?.aborted) {
        result.complete = false;
        break;
      }
      result.complete = false;
      result.errors.push(errorResult('github', error));
    }
  }
  result.contributions = [...contributions.values()];
  const used = new Set(result.contributions.map((c) => c.repositoryId));
  result.repositories = [...repos.values()].filter((r) => used.has(r.id));
  if (result.complete && !context.since && result.contributions.length)
    result.coverageStart = result.contributions.reduce(
      (earliest, c) => (c.occurredAt < earliest ? c.occurredAt : earliest),
      result.contributions[0].occurredAt,
    );
  return result;
}
