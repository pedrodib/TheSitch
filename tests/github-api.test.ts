import { afterEach, expect, it, vi } from 'vitest';
import { retryAtFromHeaders, run } from '../src/integrations/cli';
import { createGithubApi } from '../src/integrations/github-api';
import { defaultConfig } from '../src/shared/defaults';

vi.mock('../src/integrations/cli', async (original) => ({
  ...(await original<typeof import('../src/integrations/cli')>()),
  run: vi.fn(),
}));
const command = vi.mocked(run);
afterEach(() => {
  command.mockReset();
  vi.useRealTimers();
});

it('extracts server reset timing without confusing a nonempty quota with a limit', () => {
  expect(retryAtFromHeaders('X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 100', 1000)).toBe(100000);
  expect(retryAtFromHeaders('X-RateLimit-Remaining: 5\r\nX-RateLimit-Reset: 100', 1000)).toBeUndefined();
  expect(retryAtFromHeaders('Retry-After: 3', 1000)).toBe(4000);
});

it('waits until reset before reusing an exhausted search quota', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  const reset = Math.floor(Date.now() / 1000) + 5;
  command
    .mockResolvedValueOnce(
      `HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${reset}\r\n\r\n{"items":[]}`,
    )
    .mockResolvedValue('{"items":[]}');
  const progress = vi.fn();
  const api = createGithubApi(defaultConfig('/tmp'), progress);
  await api('search/issues?q=author:alice');
  const request = api('search/commits?q=author:alice');
  await vi.advanceTimersByTimeAsync(4000);
  expect(command).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await request;
  expect(command).toHaveBeenCalledTimes(2);
});

it('retries a limited request at the server reset time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  command
    .mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { retryAt: Date.now() + 5000 }))
    .mockResolvedValue('{"items":[1]}');
  const request = createGithubApi(defaultConfig('/tmp'))('search/issues?q=author:alice');
  await vi.advanceTimersByTimeAsync(4000);
  expect(command).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await request).toEqual({ items: [1] });
});

it('cancels a quota wait when configuration changes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  command.mockRejectedValue(Object.assign(new Error('Rate limited'), { retryAt: Date.now() + 60000 }));
  const abort = new AbortController();
  const request = createGithubApi(defaultConfig('/tmp'), () => {}, abort.signal)('search/issues?q=x');
  const rejected = expect(request).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await rejected;
  expect(command).toHaveBeenCalledTimes(1);
});
