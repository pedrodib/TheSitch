import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_START } from '../shared/defaults';
import type { Contribution, ImportResult, IntegrationContext, Repository } from '../shared/types';
import { errorResult, run } from './cli';

type Forge = 'gitlab' | 'bitbucket';
type Row = {
  id: number | string;
  iid: number;
  title: string;
  state: string;
  description: string;
  merged_at: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  created_on: string;
  updated_on: string;
  labels: string[];
  hash: string;
  date: string;
  message: string;
  author_email: string;
  authored_date: string;
  username: string;
  email: string;
  public_email: string;
  uuid: string;
  account_id: string;
  author?: { uuid?: string; user?: { uuid?: string } };
  links?: { html?: { href?: string } };
  update?: { state?: string; date?: string };
  values: Row[];
  next?: string;
  size?: number;
  pagelen?: number;
};
async function tokenFromFile(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error('Invalid token file');
  const info = await stat(file);
  if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0) throw new Error('Invalid token file');
  const token = (await readFile(file, 'utf8')).trim();
  if (!token) throw new Error('Empty token file');
  return token;
}
async function boundedJson(response: Response): Promise<Row> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid Bitbucket response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Bitbucket response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Row;
}
function pageCounter() {
  let count = 0;
  let expected: number | undefined;
  return (data: Row) => {
    if (
      !Array.isArray(data.values) ||
      (data.next !== undefined && (typeof data.next !== 'string' || !data.next))
    )
      throw new Error('Invalid Bitbucket pagination response');
    if (
      data.pagelen !== undefined &&
      (!Number.isSafeInteger(data.pagelen) || data.pagelen <= 0 || data.values.length > data.pagelen)
    )
      throw new Error('Invalid Bitbucket page length');
    if (data.size !== undefined) {
      if (
        !Number.isSafeInteger(data.size) ||
        data.size < 0 ||
        (expected !== undefined && expected !== data.size)
      )
        throw new Error('Bitbucket page count changed');
      expected = data.size;
    }
    count += data.values.length;
    if (expected !== undefined && (count > expected || (!data.next && count !== expected)))
      throw new Error('Incomplete Bitbucket pagination');
  };
}
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

function empty(): ImportResult {
  return { repositories: [], contributions: [], tokens: [], errors: [], complete: true, coverageStart: null };
}
function cached<T>(context: IntegrationContext, key: string, fetcher: () => Promise<T>): Promise<T> {
  return context.request ? context.request(key, fetcher) : fetcher();
}
function repository(context: IntegrationContext, source: Forge, host: string, fullName: string): Repository {
  return {
    id: `${source}:${host}:${fullName.toLowerCase()}`,
    workspaceId: context.config.workspace.id,
    source,
    name: fullName.split('/').at(-1) || fullName,
    fullName,
    url: `https://${host}/${fullName.split('/').map(encodeURIComponent).join('/')}`,
    description: '',
  };
}
function addPage(context: IntegrationContext, result: ImportResult, repo: Repository, items: Contribution[]) {
  if (items.length && !result.repositories.some((r) => r.id === repo.id)) result.repositories.push(repo);
  result.contributions.push(...items);
  if (items.length)
    context.onBatch?.({ ...empty(), repositories: [repo], contributions: items, complete: false });
}
function step(
  context: IntegrationContext,
  source: Forge,
  repo: string,
  from: string,
  to: string,
  state: 'running' | 'complete' | 'failed',
  processed: number,
) {
  context.onStep?.({
    id: `${source}:${repo}:${from}:${to}`,
    label: `${source} / ${repo}`,
    from,
    to,
    processed,
    total: state === 'complete' ? processed : null,
    state,
    detail: 'Autoria de PRs/MRs e commits; revisões não incluídas',
  });
}
function contribution(context: IntegrationContext, source: Forge, repo: Repository, item: Row): Contribution {
  const member = context.config.workspace.members[0];
  const number = source === 'gitlab' ? item.iid : item.id;
  const externalId = `${repo.id}#${number}`;
  const mergedAt = item.merged_at;
  return {
    id: `${source}:pull_request:${externalId}:${member.id}`,
    workspaceId: context.config.workspace.id,
    memberId: member.id,
    repositoryId: repo.id,
    source,
    externalId,
    kind: 'pull_request',
    title: item.title,
    body: typeof item.description === 'string' ? item.description : '',
    url: source === 'gitlab' ? item.web_url : item.links?.html?.href || '',
    occurredAt: source === 'gitlab' ? item.created_at : item.created_on,
    updatedAt: source === 'gitlab' ? item.updated_at : item.updated_on,
    state:
      mergedAt || item.state === 'MERGED'
        ? 'merged'
        : /^(closed|declined|superseded)$/i.test(item.state)
          ? 'closed'
          : 'building',
    ...(mergedAt ? { mergedAt } : {}),
    additions: 0,
    deletions: 0,
    participants: [member.id],
    labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string') : [],
  };
}
function validItem(item: Row, source: Forge): boolean {
  return !!(
    item &&
    (source === 'gitlab'
      ? Number.isSafeInteger(item.iid) && item.web_url && item.created_at && item.updated_at
      : Number.isSafeInteger(item.id) && item.links?.html?.href && item.created_on && item.updated_on) &&
    typeof item.title === 'string' &&
    typeof item.state === 'string' &&
    (source !== 'gitlab' ||
      item.state !== 'merged' ||
      (typeof item.merged_at === 'string' && Number.isFinite(Date.parse(item.merged_at)))) &&
    Number.isFinite(Date.parse(source === 'gitlab' ? item.created_at : item.created_on)) &&
    Number.isFinite(Date.parse(source === 'gitlab' ? item.updated_at : item.updated_on))
  );
}
function finish(result: ImportResult, context: IntegrationContext) {
  if (result.complete && !context.since && result.contributions.length)
    result.coverageStart = result.contributions.reduce(
      (a, c) => (c.occurredAt < a ? c.occurredAt : a),
      result.contributions[0].occurredAt,
    );
  return result;
}

export async function collectGitlab(context: IntegrationContext): Promise<ImportResult> {
  const result = empty();
  const cfg = context.config.gitlab;
  if (!cfg?.enabled) return result;
  const from = context.since && context.since > HISTORY_START ? context.since : HISTORY_START;
  const to = context.until ?? new Date().toISOString();
  if (!context.config.workspace.members[0]) return result;
  const api = (endpoint: string) =>
    cached(context, `gitlab:${cfg.host}:${cfg.username}:${endpoint}`, async () =>
      JSON.parse(await run(cfg.cli, ['api', '--hostname', cfg.host, endpoint], { signal: context.signal })),
    );
  let user: Row;
  try {
    user = JSON.parse(
      await run(cfg.cli, ['api', '--hostname', cfg.host, 'user'], { signal: context.signal }),
    );
    if (
      !cfg.username ||
      typeof user.username !== 'string' ||
      user.username.toLowerCase() !== cfg.username.toLowerCase()
    )
      throw new Error('GitLab authenticated account does not match configured username');
  } catch (error) {
    result.complete = false;
    result.errors.push(errorResult('gitlab', error));
    return result;
  }
  for (const project of cfg.projects) {
    const id = `gitlab:${project}:${from}:${to}`;
    if (context.completedSteps?.some((s) => s.id === id && s.state === 'complete')) continue;
    let processed = 0;
    step(context, 'gitlab', project, from, to, 'running', processed);
    try {
      const repo = repository(context, 'gitlab', cfg.host, project);
      for (let page = 1; page <= MAX_PAGES; page++) {
        context.signal?.throwIfAborted();
        const query = new URLSearchParams({
          scope: 'created_by_me',
          state: 'all',
          updated_after: from,
          updated_before: to,
          per_page: String(PAGE_SIZE),
          page: String(page),
        });
        const rows = await api(`projects/${encodeURIComponent(project)}/merge_requests?${query}`);
        if (!Array.isArray(rows) || rows.some((r) => !validItem(r, 'gitlab')))
          throw new Error('Invalid GitLab merge request response');
        const items = rows
          .filter(
            (r) => Date.parse(r.updated_at) >= Date.parse(from) && Date.parse(r.updated_at) <= Date.parse(to),
          )
          .map((r) => contribution(context, 'gitlab', repo, r));
        addPage(context, result, repo, items);
        processed += rows.length;
        step(context, 'gitlab', project, from, to, 'running', processed);
        if (rows.length < PAGE_SIZE) break;
        if (page === MAX_PAGES) throw new Error('GitLab pagination exceeded safe limit');
      }
      step(context, 'gitlab', project, from, to, 'complete', processed);
    } catch (error) {
      result.complete = false;
      result.errors.push(errorResult('gitlab', error));
      step(context, 'gitlab', project, from, to, 'failed', processed);
      if (context.signal?.aborted) break;
    }
  }
  const emails = new Set(
    [...(cfg.commitEmails || []), user.email, user.public_email]
      .filter((v): v is string => typeof v === 'string' && !!v)
      .map((v) => v.toLowerCase()),
  );
  for (const project of cfg.projects) {
    const label = `${project} / commits`;
    const id = `gitlab:${label}:${from}:${to}`;
    if (context.completedSteps?.some((s) => s.id === id && s.state === 'complete')) continue;
    let processed = 0;
    step(context, 'gitlab', label, from, to, 'running', processed);
    try {
      if (!emails.size) throw new Error('Configure GitLab commit emails to import authored commits');
      const repo = repository(context, 'gitlab', cfg.host, project);
      const prefix = `projects/${encodeURIComponent(project)}/repository/commits`;
      for (let page = 1; page <= MAX_PAGES; page++) {
        context.signal?.throwIfAborted();
        const query = new URLSearchParams({
          all: 'true',
          since: from,
          until: to,
          per_page: '100',
          page: String(page),
        });
        const rows = await api(`${prefix}?${query}`);
        if (
          !Array.isArray(rows) ||
          rows.some(
            (r) =>
              typeof r.id !== 'string' ||
              typeof r.author_email !== 'string' ||
              typeof r.authored_date !== 'string' ||
              !Number.isFinite(Date.parse(r.authored_date)) ||
              typeof r.title !== 'string',
          )
        )
          throw new Error('Invalid GitLab commits response');
        const items: Contribution[] = [];
        for (const row of rows) {
          if (
            !emails.has(row.author_email.toLowerCase()) ||
            row.authored_date < from ||
            row.authored_date > to
          )
            continue;
          const associated: number[] = [];
          for (let n = 1; n <= MAX_PAGES; n++) {
            const prs = await api(
              `${prefix}/${encodeURIComponent(row.id)}/merge_requests?per_page=100&page=${n}`,
            );
            if (!Array.isArray(prs) || prs.some((r) => !Number.isSafeInteger(r.iid)))
              throw new Error('Invalid GitLab commit merge requests response');
            associated.push(...prs.map((r) => r.iid));
            if (prs.length < PAGE_SIZE) break;
            if (n === MAX_PAGES) throw new Error('GitLab commit association pagination exceeded safe limit');
          }
          const member = context.config.workspace.members[0];
          items.push({
            id: `gitlab:commit:${repo.id}:${row.id}:${member.id}`,
            workspaceId: context.config.workspace.id,
            memberId: member.id,
            repositoryId: repo.id,
            source: 'gitlab',
            externalId: `${repo.id}@${row.id}`,
            kind: 'commit',
            associatedPullRequests: associated,
            title: row.title,
            body: '',
            url: row.web_url || `${repo.url}/-/commit/${encodeURIComponent(row.id)}`,
            occurredAt: row.authored_date,
            updatedAt: row.authored_date,
            state: 'merged',
            additions: 0,
            deletions: 0,
            participants: [member.id],
            labels: [],
          });
        }
        addPage(context, result, repo, items);
        processed += rows.length;
        step(context, 'gitlab', label, from, to, 'running', processed);
        if (rows.length < PAGE_SIZE) break;
        if (page === MAX_PAGES) throw new Error('GitLab commit pagination exceeded safe limit');
      }
      step(context, 'gitlab', label, from, to, 'complete', processed);
    } catch (error) {
      result.complete = false;
      result.errors.push(errorResult('gitlab', error));
      step(context, 'gitlab', label, from, to, 'failed', processed);
      if (context.signal?.aborted) break;
    }
  }
  return finish(result, context);
}

export async function collectBitbucket(context: IntegrationContext): Promise<ImportResult> {
  const result = empty();
  const cfg = context.config.bitbucket;
  if (!cfg?.enabled) return result;
  const from = context.since && context.since > HISTORY_START ? context.since : HISTORY_START;
  const to = context.until ?? new Date().toISOString();
  if (!context.config.workspace.members[0]) return result;
  try {
    const token = await tokenFromFile(cfg.tokenFile);
    const auth = `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`;
    const api = (url: string, verifyIdentity = false) => {
      const request = async () => {
        const parsed = new URL(url);
        if (parsed.origin !== 'https://api.bitbucket.org' || !parsed.pathname.startsWith('/2.0/'))
          throw new Error('Invalid Bitbucket pagination URL');
        const signal = context.signal
          ? AbortSignal.any([context.signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000);
        let response: Response;
        try {
          response = await fetch(parsed, {
            headers: { Authorization: auth, Accept: 'application/json' },
            redirect: 'error',
            signal,
          });
        } catch {
          throw new Error('Bitbucket request failed');
        }
        if (response.status === 202)
          throw new Error(
            'Bitbucket ainda está preparando os vínculos commit/PR. Confira Pull Request Commit Links e tente novamente.',
          );
        if (response.status !== 200) throw new Error(`Bitbucket request failed (HTTP ${response.status})`);
        try {
          return await boundedJson(response);
        } catch {
          throw new Error('Invalid Bitbucket response');
        }
      };
      return verifyIdentity
        ? request()
        : cached(context, `bitbucket:${cfg.email}:${cfg.accountId}:${url}`, request);
    };
    const user = await api('https://api.bitbucket.org/2.0/user', true);
    if (!user.uuid || !cfg.accountId || (user.account_id !== cfg.accountId && user.uuid !== cfg.accountId))
      throw new Error('Bitbucket authenticated account does not match configured account');
    for (const name of cfg.repositories) {
      const id = `bitbucket:${name}:${from}:${to}`;
      if (context.completedSteps?.some((s) => s.id === id && s.state === 'complete')) continue;
      let processed = 0;
      step(context, 'bitbucket', name, from, to, 'running', processed);
      try {
        const parts = name.split('/');
        if (parts.length !== 2 || parts.some((p) => !p || p === '.' || p === '..'))
          throw new Error('Invalid Bitbucket repository');
        const repo = repository(context, 'bitbucket', 'bitbucket.org', name);
        const query = new URLSearchParams({
          state: 'OPEN',
          pagelen: String(PAGE_SIZE),
          q: `updated_on >= ${new Date(from).toISOString()} AND updated_on <= ${new Date(to).toISOString()}`,
        });
        query.append('state', 'MERGED');
        query.append('state', 'DECLINED');
        query.append('state', 'SUPERSEDED');
        let next: string | undefined =
          `https://api.bitbucket.org/2.0/repositories/${parts.map(encodeURIComponent).join('/')}/pullrequests?${query}`;
        const seen = new Set<string>();
        const countPage = pageCounter();
        for (let page = 1; next && page <= MAX_PAGES; page++) {
          context.signal?.throwIfAborted();
          const parsed = new URL(next);
          if (
            parsed.origin !== 'https://api.bitbucket.org' ||
            parsed.pathname !== `/2.0/repositories/${parts.map(encodeURIComponent).join('/')}/pullrequests` ||
            seen.has(next)
          )
            throw new Error('Invalid Bitbucket pagination URL');
          seen.add(next);
          const data = await api(next);
          countPage(data);
          if (!Array.isArray(data.values) || data.values.some((r: Row) => !validItem(r, 'bitbucket')))
            throw new Error('Invalid Bitbucket pull request response');
          const items: Contribution[] = [];
          for (const row of data.values.filter(
            (r: Row) =>
              r.author?.uuid === user.uuid &&
              Date.parse(r.updated_on) >= Date.parse(from) &&
              Date.parse(r.updated_on) <= Date.parse(to),
          )) {
            if (row.state === 'MERGED') {
              const activityPath = `/2.0/repositories/${parts.map(encodeURIComponent).join('/')}/pullrequests/${row.id}/activity`;
              let activityNext: string | undefined = `https://api.bitbucket.org${activityPath}?pagelen=100`;
              const activitySeen = new Set<string>();
              const dates: string[] = [];
              const countActivity = pageCounter();
              for (let n = 1; activityNext && n <= MAX_PAGES; n++) {
                const url = new URL(activityNext);
                if (
                  url.origin !== 'https://api.bitbucket.org' ||
                  url.pathname !== activityPath ||
                  activitySeen.has(activityNext)
                )
                  throw new Error('Invalid Bitbucket activity pagination URL');
                activitySeen.add(activityNext);
                const activity = await api(activityNext);
                countActivity(activity);
                if (
                  !Array.isArray(activity.values) ||
                  (activity.next !== undefined && typeof activity.next !== 'string')
                )
                  throw new Error('Invalid Bitbucket activity response');
                for (const event of activity.values)
                  if (
                    event.update?.state === 'MERGED' &&
                    typeof event.update.date === 'string' &&
                    Number.isFinite(Date.parse(event.update.date))
                  )
                    dates.push(event.update.date);
                activityNext = activity.next;
                if (activityNext && n === MAX_PAGES)
                  throw new Error('Bitbucket activity pagination exceeded safe limit');
              }
              if (!dates.length) throw new Error('Bitbucket merge date unavailable');
              row.merged_at = dates.sort((a, b) => Date.parse(a) - Date.parse(b))[dates.length - 1];
            }
            items.push(contribution(context, 'bitbucket', repo, row));
          }
          addPage(context, result, repo, items);
          processed += data.values.length;
          step(context, 'bitbucket', name, from, to, 'running', processed);
          if (data.next !== undefined && typeof data.next !== 'string')
            throw new Error('Invalid Bitbucket pagination URL');
          next = data.next;
          if (next && page === MAX_PAGES) throw new Error('Bitbucket pagination exceeded safe limit');
        }
        step(context, 'bitbucket', name, from, to, 'complete', processed);
      } catch (error) {
        result.complete = false;
        result.errors.push(errorResult('bitbucket', error));
        step(context, 'bitbucket', name, from, to, 'failed', processed);
        if (context.signal?.aborted) break;
      }
    }
    for (const name of cfg.repositories) {
      const label = `${name} / commits`;
      const id = `bitbucket:${label}:${from}:${to}`;
      if (context.completedSteps?.some((s) => s.id === id && s.state === 'complete')) continue;
      let processed = 0;
      step(context, 'bitbucket', label, from, to, 'running', processed);
      try {
        const parts = name.split('/');
        if (parts.length !== 2 || parts.some((p) => !p || p === '.' || p === '..'))
          throw new Error('Invalid Bitbucket repository');
        const repo = repository(context, 'bitbucket', 'bitbucket.org', name);
        const base = `/2.0/repositories/${parts.map(encodeURIComponent).join('/')}`;
        const pages = async (pathname: string, visit: (r: Row) => Promise<void>) => {
          let next: string | undefined = `https://api.bitbucket.org${pathname}?pagelen=100`;
          const seen = new Set<string>();
          const countPage = pageCounter();
          for (let page = 1; next && page <= MAX_PAGES; page++) {
            context.signal?.throwIfAborted();
            const parsed = new URL(next);
            if (
              parsed.origin !== 'https://api.bitbucket.org' ||
              parsed.pathname !== pathname ||
              seen.has(next)
            )
              throw new Error('Invalid Bitbucket pagination URL');
            seen.add(next);
            const data = await api(next);
            countPage(data);
            if (!Array.isArray(data.values) || (data.next !== undefined && typeof data.next !== 'string'))
              throw new Error('Invalid Bitbucket page response');
            for (const row of data.values) await visit(row);
            next = data.next;
            if (next && page === MAX_PAGES) throw new Error('Bitbucket pagination exceeded safe limit');
          }
        };
        await pages(`${base}/commits`, async (row) => {
          if (
            typeof row.hash !== 'string' ||
            typeof row.date !== 'string' ||
            !Number.isFinite(Date.parse(row.date)) ||
            typeof row.message !== 'string'
          )
            throw new Error('Invalid Bitbucket commit response');
          processed++;
          if (
            row.author?.user?.uuid !== user.uuid ||
            Date.parse(row.date) < Date.parse(from) ||
            Date.parse(row.date) > Date.parse(to)
          )
            return;
          const associated: number[] = [];
          await pages(`${base}/commit/${encodeURIComponent(row.hash)}/pullrequests`, async (pr) => {
            if (!Number.isSafeInteger(pr.id))
              throw new Error('Invalid Bitbucket commit pull requests response');
            associated.push(Number(pr.id));
          });
          const member = context.config.workspace.members[0];
          const item: Contribution = {
            id: `bitbucket:commit:${repo.id}:${row.hash}:${member.id}`,
            workspaceId: context.config.workspace.id,
            memberId: member.id,
            repositoryId: repo.id,
            source: 'bitbucket',
            externalId: `${repo.id}@${row.hash}`,
            kind: 'commit',
            associatedPullRequests: associated,
            title: row.message.split('\n')[0],
            body: '',
            url: row.links?.html?.href || `${repo.url}/commits/${encodeURIComponent(row.hash)}`,
            occurredAt: row.date,
            updatedAt: row.date,
            state: 'merged',
            additions: 0,
            deletions: 0,
            participants: [member.id],
            labels: [],
          };
          addPage(context, result, repo, [item]);
          step(context, 'bitbucket', label, from, to, 'running', processed);
        });
        step(context, 'bitbucket', label, from, to, 'complete', processed);
      } catch (error) {
        result.complete = false;
        result.errors.push(errorResult('bitbucket', error));
        step(context, 'bitbucket', label, from, to, 'failed', processed);
        if (context.signal?.aborted) break;
      }
    }
  } catch {
    result.complete = false;
    result.errors.push(
      errorResult('bitbucket', new Error('Bitbucket authentication or token file unavailable')),
    );
  }
  return finish(result, context);
}

/** Checks configured identities without importing contribution history. */
export async function diagnoseForges(
  config: IntegrationContext['config'],
): Promise<import('../shared/types').Diagnostic[]> {
  const diagnostics: import('../shared/types').Diagnostic[] = [];
  if (config.gitlab?.enabled) {
    try {
      const user = JSON.parse(
        await run(config.gitlab.cli, ['api', '--hostname', config.gitlab.host, 'user']),
      );
      if (
        !config.gitlab.username ||
        typeof user.username !== 'string' ||
        user.username.toLowerCase() !== config.gitlab.username.toLowerCase()
      )
        throw new Error('Account mismatch');
      diagnostics.push({
        source: 'gitlab',
        installed: true,
        authenticated: true,
        version: '',
        message: 'Conta GitLab autenticada.',
      });
    } catch {
      diagnostics.push({
        source: 'gitlab',
        installed: false,
        authenticated: false,
        version: '',
        message: 'Confira o glab, a autenticação e a conta GitLab configurada.',
      });
    }
  }
  if (config.bitbucket?.enabled) {
    try {
      const cfg = config.bitbucket;
      const token = await tokenFromFile(cfg.tokenFile);
      const response = await fetch('https://api.bitbucket.org/2.0/user', {
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error('Authentication failed');
      const user = await boundedJson(response);
      if (!user.uuid || !cfg.accountId || (user.uuid !== cfg.accountId && user.account_id !== cfg.accountId))
        throw new Error('Account mismatch');
      diagnostics.push({
        source: 'bitbucket',
        installed: true,
        authenticated: true,
        version: '',
        message: 'Conta Bitbucket autenticada.',
      });
    } catch {
      diagnostics.push({
        source: 'bitbucket',
        installed: true,
        authenticated: false,
        version: '',
        message: 'Confira o arquivo de token e a conta Bitbucket configurada.',
      });
    }
  }
  return diagnostics;
}
