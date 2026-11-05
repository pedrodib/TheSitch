import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ImportJournal } from '../src/backend/import-history';
import { Store } from '../src/backend/store';
import { collectClaude, parseClaudeUsage } from '../src/integrations/claude';
import { defaultConfig } from '../src/shared/defaults';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const row = (id: string, output = 5, cwd = '/work/project') =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'session',
    requestId: `req-${id}`,
    uuid: `event-${id}`,
    cwd,
    timestamp: '2026-10-05T15:00:00Z',
    message: {
      id,
      model: 'claude-test',
      content: [{ text: 'private-content' }],
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
        output_tokens: output,
        cache_creation: { ephemeral_5m_input_tokens: 10 },
        output_tokens_details: { thinking_tokens: 3 },
      },
    },
  });
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sitch-claude-'));
  dirs.push(dir);
  const config = defaultConfig(dir);
  const sessions = path.join(dir, 'claude-projects');
  config.claudeSessionsPath = sessions;
  config.organizations = ['corp'];
  config.repoMappings = { '/work': 'corp/repo', '/work/personal': 'personal/repo' };
  await mkdir(path.join(sessions, 'project', 'session', 'subagents'), { recursive: true });
  const repositories = [
    {
      id: 'repo',
      workspaceId: config.workspace.id,
      name: 'repo',
      fullName: 'corp/repo',
      url: '',
      description: '',
    },
  ];
  return { dir, sessions, config, context: { config, repositories, since: null, onProgress: () => {} } };
}

it('counts cached input once and ignores nested cache and thinking breakdowns', () => {
  const event = parseClaudeUsage(row('one'));
  expect(event).toMatchObject({ input: 32, cached: 20, cacheWrite: 10, output: 5, total: 37 });
  expect(JSON.stringify(event)).not.toContain('private-content');
  expect(parseClaudeUsage('invalid')).toBeNull();
  expect(parseClaudeUsage(row('one').replace('"output_tokens":5', '"output_tokens":-1'))).toBeNull();
});

it('deduplicates content blocks and inherited context while retaining new subagent work', async () => {
  const { sessions, context } = await setup();
  await writeFile(path.join(sessions, 'project', 'session.jsonl'), [row('one'), row('one', 7)].join('\n'));
  await writeFile(
    path.join(sessions, 'project', 'session', 'subagents', 'agent.jsonl'),
    [row('one'), row('two'), row('personal', 5, '/work/personal'), '{incomplete'].join('\n'),
  );
  const result = await collectClaude(context);
  expect(result.complete).toBe(true);
  expect(result.tokens.map((item) => item.total).sort()).toEqual([37, 39]);
  expect(result.tokens.every((item) => item.provider === 'claude' && item.repositoryId === 'repo')).toBe(
    true,
  );
});

it('refreshes growing usage without duplicating records or regressing to copied older snapshots', async () => {
  const { sessions, context, config } = await setup();
  const file = path.join(sessions, 'project', 'session.jsonl');
  await writeFile(file, `${row('one')}\n`);
  const store = new Store(':memory:', config);
  try {
    const first = await collectClaude(context);
    store.importResult({ ...first, repositories: context.repositories });
    await appendFile(file, `${row('one', 9)}\n`);
    const next = await collectClaude({ ...context, since: '2026-10-04T00:00:00Z' });
    store.importResult(next);
    store.importResult(first);
    expect(store.getTokens()).toHaveLength(1);
    expect(store.getTokens()[0].total).toBe(41);
  } finally {
    store.close();
  }
});

it('leaves unknown repositories unassigned and treats an absent Claude installation as empty', async () => {
  const { sessions, context } = await setup();
  await writeFile(path.join(sessions, 'project', 'session.jsonl'), row('one', 5, ''));
  expect((await collectClaude(context)).tokens[0].repositoryId).toBeNull();
  context.config.claudeSessionsPath = path.join(sessions, 'missing');
  expect(await collectClaude(context)).toMatchObject({ complete: true, tokens: [], errors: [] });
});

it('adds the default Claude path when opening existing settings and resets its checkpoint after path changes', async () => {
  const { dir, config } = await setup();
  const db = path.join(dir, 'db.sqlite');
  let store = new Store(db, config);
  const old = store.getConfig();
  delete old.claudeSessionsPath;
  store.saveConfig(old);
  store.close();
  store = new Store(db, defaultConfig(dir));
  try {
    expect(store.getConfig().claudeSessionsPath).toBe(`${dir}/.claude/projects`);
    store.setCheckpoint('claude', '2026-10-05T00:00:00Z');
    store.saveConfig({ ...store.getConfig(), claudeSessionsPath: path.join(dir, 'another') });
    expect(store.getCheckpoint('claude')).toBeNull();
  } finally {
    store.close();
  }
});

it('discovers a newly copied file with old timestamps and reuses unchanged file metadata', async () => {
  const { sessions, context, config } = await setup();
  const store = new Store(':memory:', config);
  const journal = new ImportJournal(store);
  const firstFile = path.join(sessions, 'project', 'one.jsonl');
  await writeFile(firstFile, row('one'));
  await utimes(firstFile, new Date('2020-01-01'), new Date('2020-01-01'));
  try {
    const run = journal.begin('claude', false);
    const cached = journal.context(
      run,
      () => true,
      new AbortController().signal,
      () => {},
    );
    const first = await collectClaude({ ...context, since: '2026-11-05T00:00:00Z', ...cached });
    expect(first.tokens).toHaveLength(1);
    const newFile = path.join(sessions, 'project', 'two.jsonl');
    await writeFile(newFile, row('two'));
    await utimes(newFile, new Date('2020-01-01'), new Date('2020-01-01'));
    const second = await collectClaude({ ...context, since: '2026-11-05T00:00:00Z', ...cached });
    expect(second.tokens).toHaveLength(2);
    expect(run.reusedRequests).toBeGreaterThan(0);
    expect(run.requests).toBe(2);
  } finally {
    store.close();
  }
});
