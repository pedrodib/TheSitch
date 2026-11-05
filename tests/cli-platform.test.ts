import { describe, expect, it } from 'vitest';
import { cliEnvironment, cliInvocation, findExecutable } from '../src/integrations/cli-platform';

const files =
  (...paths: string[]) =>
  async (candidate: string) => {
    if (!paths.some((item) => item.toLowerCase() === candidate.toLowerCase())) throw new Error('missing');
  };

describe('CLI platform support', () => {
  it('prefers the user PATH before fallback locations', async () => {
    const env = cliEnvironment({ PATH: '/custom/bin:/usr/bin' }, 'linux', '/home/user');
    expect(await findExecutable('gh', env, 'linux', files('/custom/bin/gh', '/usr/bin/gh'))).toBe(
      '/custom/bin/gh',
    );
  });

  it('preserves Windows Path casing and searches PATHEXT in PATH order', async () => {
    const env = cliEnvironment({ Path: 'C:\\first;C:\\second', PATHEXT: '.EXE;.CMD' }, 'win32');
    expect(env.PATH).toBeUndefined();
    expect(
      await findExecutable('codex', env, 'win32', files('C:\\first\\codex.cmd', 'C:\\second\\codex.exe')),
    ).toBe('C:\\first\\codex.CMD');
  });

  it('passes untrusted arguments directly to the known npm entry point', async () => {
    const args = ['& calc.exe', '$(touch pwned)', '" | whoami'];
    const result = await cliInvocation(
      'C:\\npm\\codex.cmd',
      args,
      'win32',
      files('C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'),
    );
    expect(result).toEqual({
      bin: process.execPath,
      args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', ...args],
      nodeMode: true,
    });
  });

  it('rejects other batch files without invoking a shell', async () => {
    await expect(cliInvocation('C:\\azure\\az.cmd', ['& calc'], 'win32')).rejects.toThrow(
      'executável nativo',
    );
  });
});
