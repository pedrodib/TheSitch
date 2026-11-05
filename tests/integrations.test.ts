import { describe, expect, it } from 'vitest';
import { parseAnalysisUsage, validateAssessment } from '../src/integrations';
import { run } from '../src/integrations/cli';
import { parseSession } from '../src/integrations/codex';

describe('CLI failure diagnostics', () => {
  it('preserves only retry timing from a rate-limited response', async () => {
    const started = Date.now();
    const failure = await run(process.execPath, [
      '-e',
      'process.stdout.write("HTTP/2.0 429 Too Many Requests\\r\\nRetry-After: 2\\r\\n\\r\\nprivate-response"); process.stderr.write("gh: HTTP 429 rate limit exceeded credential=private-value"); process.exit(1);',
    ]).catch((error: Error & { retryAt: number }) => error);
    expect((failure as Error & { retryAt: number }).retryAt).toBeGreaterThanOrEqual(started + 2000);
    expect((failure as Error).message).not.toMatch(/private-value|private-response/);
  });
  it.each([
    ['gh: HTTP 401 Bad credentials', 'Autenticação recusada'],
    ['gh: HTTP 403 Forbidden', 'Acesso recusado'],
    ['gh: HTTP 404 Not Found', 'Recurso não encontrado'],
    ['gh: HTTP 422 Validation Failed', 'Consulta recusada'],
    ['gh: SAML SSO authorization required (HTTP 403)', 'exige autorização SSO'],
    ['gh: error connecting to api.github.com', 'Sem conexão'],
  ])('explains %s without leaking stderr', async (stderr, expected) => {
    const failure = await run(process.execPath, [
      '-e',
      `process.stderr.write(${JSON.stringify(`${stderr}\ncredential=private-value`)}); process.exit(1);`,
    ]).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(expected);
    expect((failure as Error).message).not.toContain('private-value');
  });
});

describe('Codex token snapshots', () => {
  it('accounts for analysis overhead without double-counting cached input tokens', () => {
    const data = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20 },
    });
    expect(parseAnalysisUsage(`${data}\nnot json\n`)).toEqual({
      input: 100,
      cached: 30,
      output: 20,
      total: 120,
    });
  });
  it('counts duplicate snapshots once and handles counter resets and incomplete lines', () => {
    const snapshot = (total: number, time: string) =>
      JSON.stringify({
        timestamp: time,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: total - 2,
              cached_input_tokens: 1,
              output_tokens: 2,
              total_tokens: total,
            },
          },
        },
      });
    const input = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd: '/work' } }),
      snapshot(10, '2026-01-01'),
      snapshot(10, '2026-01-02'),
      snapshot(20, '2026-01-03'),
      snapshot(5, '2026-01-04'),
      '{',
    ].join('\n');
    const parsed = parseSession(input, 'fallback');
    expect(parsed.events.map((e) => e.usage.total_tokens)).toEqual([10, 10, 5]);
    expect(parsed.id).toBe('session');
  });
});
describe('assessment validation', () => {
  const assessment = {
    headline: 'a',
    summary: 'b',
    caveat: 'c',
    priority: 'd',
    rhythm: 'usual',
    confidence: 'low',
    evidenceIds: ['one'],
  };
  it('accepts only known evidence', () => {
    expect(validateAssessment(assessment, new Set(['one'])).source).toBe('luna');
    expect(() => validateAssessment(assessment, new Set())).toThrow();
  });
});

describe('assessment input validation', () => {
  const good = {
    headline: 'a',
    summary: 'b',
    caveat: 'c',
    priority: 'd',
    rhythm: 'usual',
    confidence: 'low',
    evidenceIds: [],
  };
  it('rejects an unknown rhythm', () => {
    expect(() => validateAssessment({ ...good, rhythm: 'great' }, new Set())).toThrow();
  });
  it('rejects an unknown confidence', () => {
    expect(() => validateAssessment({ ...good, confidence: 'certain' }, new Set())).toThrow();
  });
  it('rejects malformed evidence', () => {
    expect(() => validateAssessment({ ...good, evidenceIds: [5] }, new Set())).toThrow();
  });
  it('rejects excessively long generated fields', () => {
    expect(() => validateAssessment({ ...good, summary: 'x'.repeat(4001) }, new Set())).toThrow();
  });
});
