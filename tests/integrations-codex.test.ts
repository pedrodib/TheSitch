import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { run } from '../src/integrations/cli';
import { collectCodex } from '../src/integrations/codex';
import { defaultConfig } from '../src/shared/defaults';

it('excludes personal work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sitch-test-'));
  try {
    const sessions = path.join(dir, 'sessions');
    const archived = path.join(dir, 'archived_sessions');
    await mkdir(sessions);
    await mkdir(archived);
    const content = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'one', cwd: '/personal' } }),
      JSON.stringify({
        timestamp: '2025-01-01T00:00:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } },
        },
      }),
    ].join('\n');
    await writeFile(path.join(sessions, 'one.jsonl'), content);
    await writeFile(path.join(archived, 'copy.jsonl'), content);
    const config = defaultConfig(dir);
    config.codexSessionsPath = sessions;
    config.organizations = ['corp'];
    config.repoMappings['/personal'] = 'personal/repo';
    const result = await collectCodex({
      config,
      since: null,
      repositories: [
        {
          id: 'personal',
          workspaceId: config.workspace.id,
          name: 'repo',
          fullName: 'personal/repo',
          url: '',
          description: '',
        },
      ],
      onProgress: () => {},
    });
    expect(result.tokens).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('passes shell metacharacters as literal arguments', async () => {
  const argument = '$(echo injected); echo dangerous';
  const output = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  expect(output).toBe(argument);
});
it('attributes snapshots to their turn context and removes inherited parent snapshots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sitch-test-'));
  try {
    const sessions = path.join(dir, 'sessions');
    await mkdir(sessions);
    const meta = (id: string, parent_id?: string) =>
      JSON.stringify({ type: 'session_meta', payload: { id, parent_id, cwd: '/unknown' } });
    const turn = (cwd: string, model: string) =>
      JSON.stringify({ type: 'turn_context', payload: { cwd, model } });
    const snapshot = (time: string, total: number) =>
      JSON.stringify({
        timestamp: time,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } },
        },
      });
    const first = snapshot('2026-01-01', 10);
    await writeFile(
      path.join(sessions, 'parent.jsonl'),
      [
        meta('parent'),
        turn('/work/a', 'one'),
        first,
        turn('/work/b', 'two'),
        snapshot('2026-01-02', 20),
      ].join('\n'),
    );
    await writeFile(
      path.join(sessions, 'child.jsonl'),
      [meta('child', 'parent'), turn('/work/a', 'one'), first].join('\n'),
    );
    const config = defaultConfig(dir);
    config.codexSessionsPath = sessions;
    config.organizations = ['corp'];
    config.repoMappings = { '/work/a': 'corp/a', '/work/b': 'corp/b' };
    const repositories = ['a', 'b'].map((name) => ({
      id: name,
      workspaceId: config.workspace.id,
      name,
      fullName: `corp/${name}`,
      url: '',
      description: '',
    }));
    const result = await collectCodex({ config, repositories, since: null, onProgress: () => {} });
    expect(result.tokens.map((t) => [t.repositoryId, t.model, t.total])).toEqual([
      ['a', 'one', 10],
      ['b', 'two', 10],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
