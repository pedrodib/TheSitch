import { readFile, writeFile } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/backend/demo';
import { buildDashboard } from '../src/backend/metrics';
import { analyzeWithLuna } from '../src/integrations';
import { run } from '../src/integrations/cli';
import { defaultConfig } from '../src/shared/defaults';
import type { Dashboard, SyncStatus } from '../src/shared/types';

vi.mock('../src/integrations/cli', () => ({ run: vi.fn(), errorResult: vi.fn() }));
const command = vi.mocked(run);
const status: SyncStatus = {
  running: false,
  paused: false,
  phase: '',
  lastSync: null,
  errors: [],
  coverageStart: '2026-01-01',
  coverageComplete: true,
};
const config = defaultConfig('/example');
function dashboard(count: number): Dashboard {
  const demo = createDemoData(config);
  const contributions = Array.from({ length: count }, (_, index) => ({
    ...demo.contributions[0],
    id: `evidence-${index}`,
    body: 'Contexto da entrega. '.repeat(150),
  }));
  return buildDashboard(
    config,
    demo.repositories,
    contributions,
    [],
    status,
    { start: '2026-01-01', end: '2026-12-31' },
    true,
  );
}
beforeEach(() => {
  command.mockReset();
  command.mockImplementation(async (_bin, args, options) => {
    const prompt = options?.input ?? '';
    const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      evidence?: { id: string }[];
      analysisNotes?: { evidenceIds: string[] }[];
    };
    const evidenceIds =
      payload.evidence?.slice(0, 2).map((item) => item.id) ??
      payload.analysisNotes?.flatMap((note) => note.evidenceIds).slice(0, 2) ??
      [];
    const outputSchema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
    const allowed =
      payload.evidence?.map((item) => item.id) ??
      payload.analysisNotes?.flatMap((note) => note.evidenceIds) ??
      [];
    expect(outputSchema.properties.evidenceIds.items.enum ?? []).toEqual([...new Set(allowed)]);
    expect(outputSchema.properties.summary.maxLength).toBe(4000);
    expect(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).deterministicAssessment.evidenceIds).toEqual(
      [],
    );
    const file = args[args.indexOf('--output-last-message') + 1];
    await writeFile(
      file,
      JSON.stringify({
        headline: 'As obras avançam',
        summary: 'Contribuições observadas.',
        caveat: 'Impacto não medido.',
        priority: 'Acompanhar resultados.',
        rhythm: 'insufficient',
        confidence: 'low',
        evidenceIds,
      }),
    );
    return JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
    });
  });
});
it('sends context on stdin and validates the structured response against supplied evidence', async () => {
  const result = await analyzeWithLuna(config, dashboard(1));
  expect(command).toHaveBeenCalledOnce();
  expect(command.mock.calls[0][1].at(-1)).toBe('-');
  expect(command.mock.calls[0][1]).toContain('read-only');
  expect(result.evidenceIds).toEqual(['evidence-0']);
  expect(result.usage?.total).toBe(110);
});
it('partitions a large month into bounded batches and counts the entire analysis overhead', async () => {
  const result = await analyzeWithLuna(config, dashboard(140));
  expect(command.mock.calls.length).toBeGreaterThan(2);
  for (const call of command.mock.calls) expect(call[2]?.input?.length).toBeLessThan(98000);
  expect(result.usage?.total).toBe(command.mock.calls.length * 110);
  expect(result.evidenceIds.every((id) => id.startsWith('evidence-'))).toBe(true);
});

it('retries invalid evidence with feedback and accounts for both completed attempts', async () => {
  command.mockImplementationOnce(async (_bin, args) => {
    await writeFile(
      args[args.indexOf('--output-last-message') + 1],
      JSON.stringify({
        headline: 'Manchete',
        summary: 'Resumo',
        caveat: 'Limites',
        priority: 'Prioridade',
        rhythm: 'usual',
        confidence: 'low',
        evidenceIds: ['outside-this-batch'],
      }),
    );
    return JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } });
  });
  const result = await analyzeWithLuna(config, dashboard(1));
  expect(command).toHaveBeenCalledTimes(2);
  expect(command.mock.calls[1][2]?.input).toContain('evidenceIds contém referências fora do lote');
  expect(result.evidenceIds).toEqual(['evidence-0']);
  expect(result.usage?.total).toBe(117);
});

it('reports the invalid field after bounded retries instead of accepting fabricated evidence', async () => {
  command.mockImplementation(async (_bin, args) => {
    await writeFile(
      args[args.indexOf('--output-last-message') + 1],
      JSON.stringify({
        headline: 'Manchete',
        summary: 'Resumo',
        caveat: 'Limites',
        priority: 'Prioridade',
        rhythm: 'usual',
        confidence: 'low',
        evidenceIds: ['unknown'],
      }),
    );
    return '';
  });
  await expect(analyzeWithLuna(config, dashboard(1))).rejects.toThrow(
    'evidenceIds contém referências fora do lote',
  );
  expect(command).toHaveBeenCalledTimes(2);
});
