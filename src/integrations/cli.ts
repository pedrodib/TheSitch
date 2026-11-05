import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { cliEnvironment, cliInvocation, findExecutable } from './cli-platform';

const execute = promisify(execFile);

/** Extracts only retry timing; response bodies and credentials never leave the CLI boundary. */
export function retryAtFromHeaders(headers: string, now = Date.now()): number | undefined {
  const after = /^retry-after:\s*([^\r\n]+)/im.exec(headers)?.[1].trim();
  if (after) {
    const date = /^\d+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  if (/^x-ratelimit-remaining:\s*0\s*$/im.test(headers)) {
    const reset = /^x-ratelimit-reset:\s*(\d+)/im.exec(headers)?.[1];
    const until = Number(reset) * 1000;
    if (reset && Number.isFinite(until) && until < 8.64e15) return Math.max(now, until);
  }
  return undefined;
}
export async function executable(command: string): Promise<string> {
  return findExecutable(command, cliEnvironment(process.env));
}
export async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const env = cliEnvironment(options.env || process.env);
  const bin = await findExecutable(command, env);
  const invocation = await cliInvocation(bin, args);
  if (invocation.nodeMode) env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const task = execute(invocation.bin, invocation.args, {
      cwd: options.cwd || os.homedir(),
      env,
      timeout: options.timeout || 60_000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
      signal: options.signal,
    });
    task.child.stdin?.end(options.input);
    const result = await task;
    return result.stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; stdout?: string };
    // Classify failures without exposing command arguments, credentials or raw CLI output.
    const detail = String(e.stderr || '');
    if (/rate limit exceeded|secondary rate limit|HTTP 429/i.test(detail))
      throw Object.assign(new Error('Limite de consultas do serviço atingido. Tente novamente mais tarde.'), {
        retryAt: retryAtFromHeaders(String(e.stdout || '')) ?? Date.now() + 60_000,
      });
    if (/SAML|single sign.on|SSO/i.test(detail))
      throw new Error('A organização exige autorização SSO para a conta usada pelo CLI.');
    if (/HTTP 401|bad credentials|not logged into|token[^\n]*invalid/i.test(detail))
      throw new Error('Autenticação recusada (HTTP 401). Confira o login no CLI da integração.');
    if (/HTTP 403/i.test(detail))
      throw new Error('Acesso recusado (HTTP 403). Confira as permissões do CLI na organização.');
    if (/HTTP 404/i.test(detail))
      throw new Error(
        'Recurso não encontrado ou sem acesso (HTTP 404). Confira a organização e as permissões.',
      );
    if (/HTTP 422/i.test(detail))
      throw new Error(
        'Consulta recusada pelo serviço (HTTP 422). Confira o login e a organização configurados.',
      );
    if (
      /error connecting|could not resolve|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network is unreachable/i.test(
        detail,
      )
    )
      throw new Error('Sem conexão com o serviço. Confira a rede e tente novamente.');
    throw new Error(
      e.killed
        ? 'Command timed out'
        : e.code === 'ENOENT'
          ? 'Executable not found'
          : 'Command failed; check CLI authentication and permissions',
    );
  }
}
export function errorResult(source: string, error: unknown) {
  return {
    source,
    message: error instanceof Error ? error.message : 'Integration failed',
    at: new Date().toISOString(),
  };
}
