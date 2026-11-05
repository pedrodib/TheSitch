import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Platform = NodeJS.Platform;
type Exists = (candidate: string, mode: number) => Promise<void>;

function pathKey(env: NodeJS.ProcessEnv, platform: Platform): string {
  return platform === 'win32'
    ? Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path'
    : 'PATH';
}

export function cliEnvironment(
  base: NodeJS.ProcessEnv,
  platform: Platform = process.platform,
  home = os.homedir(),
): NodeJS.ProcessEnv {
  const key = pathKey(base, platform);
  const paths =
    platform === 'win32'
      ? []
      : [
          path.join(home, '.local/bin'),
          path.join(home, '.npm-global/bin'),
          ...(platform === 'darwin' ? [path.join(home, 'Library/pnpm'), '/opt/homebrew/bin'] : []),
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
        ];
  const env = { ...base };
  env[key] = [base[key], ...paths].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  return env;
}

export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
  exists: Exists = access,
): Promise<string> {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const isWindows = platform === 'win32';
  const hasPath = paths.isAbsolute(command) || command.includes('/') || (isWindows && command.includes('\\'));
  const extensions =
    isWindows && !paths.extname(command)
      ? (Object.entries(env).find(([key]) => key.toLowerCase() === 'pathext')?.[1] || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  const directories = hasPath ? [''] : (env[pathKey(env, platform)] || '').split(isWindows ? ';' : ':');
  for (const dir of directories) {
    if (!hasPath && (!dir || !paths.isAbsolute(dir))) continue;
    for (const extension of extensions) {
      const candidate = hasPath ? command + extension : paths.join(dir, command + extension);
      try {
        await exists(candidate, isWindows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* try next */
      }
    }
  }
  return command;
}

/** Batch files require a shell on Windows, so only execute a known npm entry point directly. */
export async function cliInvocation(
  bin: string,
  args: string[],
  platform: Platform = process.platform,
  exists: Exists = access,
): Promise<{ bin: string; args: string[]; nodeMode?: boolean }> {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(bin)) return { bin, args };
  if (path.win32.basename(bin).toLowerCase() === 'codex.cmd') {
    const script = path.win32.join(
      path.win32.dirname(bin),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    try {
      await exists(script, constants.F_OK);
      return { bin: process.execPath, args: [script, ...args], nodeMode: true };
    } catch {
      /* unsupported shim */
    }
  }
  throw new Error(
    'Este CLI usa um arquivo .cmd ou .bat não suportado. Configure o caminho de um executável nativo (.exe).',
  );
}
