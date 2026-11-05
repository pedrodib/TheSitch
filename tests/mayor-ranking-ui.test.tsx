// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MayorRankingPanel } from '../src/renderer/mayor-ranking';
import type { MayorRanking } from '../src/shared/types';

it('shows provisional placement, the comparison universe and persists the chosen cadence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const period = { start: '2026-11-01', end: '2026-11-05' };
  const data: MayorRanking = {
    period,
    organizations: ['corp'],
    intervalHours: 2,
    running: false,
    phase: 'Pendente',
    error: null,
    checkedAt: null,
    nextAt: null,
    completedDays: 2,
    totalDays: 5,
    repositories: 3,
    partial: true,
    rows: [{ login: 'alice', merged: 4, rank: 1, me: true }],
    mean: 2,
    median: 2,
    mine: 4,
    difference: 100,
  };
  const refreshMayorRanking = vi.fn(async () => data);
  const getMayorRanking = vi.fn(async () => data),
    setRankingInterval = vi.fn(async () => {});
  Object.defineProperty(window, 'theSitch', {
    value: { getMayorRanking, setRankingInterval, refreshMayorRanking },
    configurable: true,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<MayorRankingPanel period={period} demo={false} timezone="America/Sao_Paulo" />),
    );
    expect(host.textContent).toContain('Classificação provisória');
    expect(host.textContent).toContain('America/Sao_Paulo');
    expect(host.textContent).toContain('PRs criados');
    expect(host.querySelector('thead')?.textContent).toContain('PRs mergeados');
    expect(host.textContent).not.toContain('dias em UTC');
    expect(host.textContent).toContain('+100%');
    expect(host.textContent).toContain('alice');
    expect(host.textContent).toContain('não todos os funcionários');
    const select = host.querySelector('select');
    if (!select) throw Error('interval absent');
    await act(async () => {
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setRankingInterval).toHaveBeenCalledWith(3);
    await act(async () => host.querySelector<HTMLButtonElement>('.league-refresh')?.click());
    expect(refreshMayorRanking).toHaveBeenCalledWith(period);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
