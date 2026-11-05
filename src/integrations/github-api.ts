import type { AppConfig } from '../shared/types';
import { retryAtFromHeaders, run } from './cli';

export type GithubApi = (endpoint: string) => Promise<unknown>;

/** Serial requests respect the server's quota headers and retry bounded transient limits. */
export function createGithubApi(
  config: AppConfig,
  onProgress: (phase: string) => void = () => {},
  signal?: AbortSignal,
  onWait: (until: number | null) => void = () => {},
): GithubApi {
  const blockedUntil = new Map<string, number>();
  async function waitUntil(until: number) {
    const time = new Date(until).toLocaleTimeString('pt-BR', { timeZone: config.calendar.timezone });
    if (Date.now() < until) onWait(until);
    while (Date.now() < until) {
      signal?.throwIfAborted();
      onProgress(`GitHub: aguardando liberação da cota às ${time}. A importação continua automaticamente.`);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          Math.min(30_000, until - Date.now()),
        );
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    onWait(null);
  }
  return async (endpoint) => {
    const resource = endpoint.startsWith('search/') ? 'search' : 'core';
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      await waitUntil(blockedUntil.get(resource) ?? 0);
      signal?.throwIfAborted();
      let output: string;
      try {
        output = await run(config.cli.gh, ['api', '--include', '--hostname', config.githubHost, endpoint], {
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        const retryAt = (error as { retryAt?: number }).retryAt;
        if (typeof retryAt === 'number' && Number.isFinite(retryAt) && attempt < 2) {
          blockedUntil.set(resource, Date.now() + Math.max(1000, retryAt - Date.now()) * 2 ** attempt + 1000);
          continue;
        }
        throw new Error(
          `${endpoint.split('?')[0]}: ${error instanceof Error ? error.message : 'Falha na consulta ao GitHub.'}`,
        );
      }
      // gh --include can emit redirect headers before the final JSON response.
      while (output.startsWith('HTTP/')) {
        const separator = /\r?\n\r?\n/.exec(output);
        if (!separator || separator.index === undefined) break;
        const headers = output.slice(0, separator.index);
        const retryAt = retryAtFromHeaders(headers);
        if (retryAt !== undefined) blockedUntil.set(resource, retryAt + 1000);
        output = output.slice(separator.index + separator[0].length).trimStart();
      }
      try {
        return JSON.parse(output);
      } catch {
        throw new Error(`${endpoint.split('?')[0]}: O GitHub retornou uma resposta inválida.`);
      }
    }
  };
}
