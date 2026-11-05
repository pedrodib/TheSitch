// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createDemoData } from '../src/backend/demo';
import { buildDashboard } from '../src/backend/metrics';
import { defaultConfig } from '../src/shared/defaults';
import type { AppConfig, Period, SyncStatus, TheSitchApi } from '../src/shared/types';

it('navega onboarding, demonstração, períodos, bairros e configurações', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  let config = defaultConfig('/example');
  // Saving identity/preferences alone must not hide the path to the first GitHub import.
  config.onboardingComplete = true;
  let demo = false;
  const status: SyncStatus = {
    running: false,
    paused: false,
    phase: 'Pronto',
    lastSync: null,
    errors: [],
    coverageStart: null,
    coverageComplete: false,
  };
  const api: TheSitchApi = {
    getMayorRanking: vi.fn(),
    refreshMayorRanking: vi.fn(),
    setRankingInterval: vi.fn(),
    getImportHistory: vi.fn(async () => ({
      sources: [],
      syncMinutes: 10,
      running: false,
      paused: false,
      generatedAt: new Date().toISOString(),
    })),
    getConfig: vi.fn(async () => structuredClone(config)),
    saveConfig: vi.fn(async (next: AppConfig) => {
      config = structuredClone(next);
      return next;
    }),
    getDashboard: vi.fn(async (period: Period) => {
      const data = createDemoData(config);
      for (let i = 0; i < 9; i++)
        data.repositories.push({
          ...data.repositories[0],
          id: `zz-extra-${i}`,
          name: `Extra ${i}`,
          fullName: `demo/extra-${i}`,
        });
      return buildDashboard(
        config,
        demo ? data.repositories : [],
        demo ? data.contributions : [],
        demo ? data.tokens : [],
        { ...status, coverageComplete: demo, coverageStart: data.coverageStart },
        period,
        demo,
      );
    }),
    sync: vi.fn(async () => status),
    setPaused: vi.fn(async (paused) => ({ ...status, paused })),
    diagnostics: vi.fn(async () => []),
    discover: vi.fn(async () => ({ login: 'alice', organizations: ['corp'] })),
    analyze: vi.fn(),
    setDemo: vi.fn(async (value) => {
      demo = value;
    }),
    openExternal: vi.fn(),
    exportConfig: vi.fn(async () => true),
    importConfig: vi.fn(async () => null),
    groupContributions: vi.fn(),
    onStatus: vi.fn(() => () => {}),
  };
  window.theSitch = api;
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import('../src/renderer/main');
  });
  expect(document.body.textContent).toContain('Vamos conectar sua cidade?');
  expect(document.body.textContent).toContain('Importar histórico');
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
    );
    expect(button, label).toBeTruthy();
    await act(async () => {
      button?.click();
    });
  };
  await click('Importar histórico');
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  expect(document.body.textContent).toContain('Verificar CLIs e descobrir organizações');
  await click('Fechar configurações');
  await click('Explorar demonstração');
  expect(document.body.textContent).toContain('MODO DEMO');
  expect(document.querySelectorAll('.district-marker').length).toBeGreaterThan(0);
  expect(document.body.textContent).toContain('City Signal');
  expect(document.body.textContent).toContain('Claude Code:');
  await click('Últimos 30 dias');
  const rollingPeriod = vi.mocked(api.getDashboard).mock.lastCall?.[0];
  expect(rollingPeriod?.rolling).toBe(true);
  expect((Date.parse(rollingPeriod?.end ?? '') - Date.parse(rollingPeriod?.start ?? '')) / 86400000).toBe(29);
  await click('Hoje');
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  expect(api.getDashboard).toHaveBeenLastCalledWith({ start: date, end: date });
  await click('Personalizado');
  expect(document.querySelector('input[aria-label="Data inicial"]')).toBeTruthy();
  const initialDate = document.querySelector<HTMLInputElement>('input[aria-label="Data inicial"]');
  if (!initialDate) throw new Error('Missing date input');
  const originalDate = initialDate.value;
  const requestsBeforeEditing = vi.mocked(api.getDashboard).mock.calls.length;
  const setDate = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(initialDate, value);
      initialDate.dispatchEvent(new Event('input', { bubbles: true }));
      initialDate.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await setDate('');
  expect(document.querySelector('svg.city')).toBeTruthy();
  expect(document.body.textContent).toContain('A cidade mantém o último período válido');
  expect(vi.mocked(api.getDashboard).mock.calls.length).toBe(requestsBeforeEditing);
  await setDate(originalDate);
  await click('Últimos 30 dias');

  await click('Aumentar zoom');
  expect(document.querySelector('svg.city > g')?.getAttribute('transform')).toContain('scale(1.2)');
  const beforeRotation = document.querySelector('[data-city-layer=buildings]')?.getAttribute('data-angle');
  await click('Girar cidade à direita');
  expect(document.querySelector('[data-city-layer=buildings]')?.getAttribute('data-angle')).not.toBe(
    beforeRotation,
  );
  const city = document.querySelector<SVGSVGElement>('svg.city');
  if (!city) throw new Error('Cidade não renderizada');
  city.setPointerCapture = vi.fn();
  city.hasPointerCapture = vi.fn(() => true);
  city.releasePointerCapture = vi.fn();
  const pointer = async (type: string, x: number, button = 2) => {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100, button });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      city.dispatchEvent(event);
    });
  };
  const wheel = async (deltaY: number) => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    await act(async () => {
      city.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  };
  const camera = () => city.querySelector('g')?.getAttribute('transform');
  const beforeZoom = camera();
  await wheel(-100);
  expect(camera()).not.toBe(beforeZoom);
  await wheel(100);
  const scale = Number(camera()?.match(/scale\(([^)]+)\)/)?.[1]);
  expect(scale).toBeCloseTo(1.2);
  for (let i = 0; i < 12; i++) await wheel(-500);
  expect(camera()).toContain('scale(2.2)');
  for (let i = 0; i < 12; i++) await wheel(500);
  expect(camera()).toContain('scale(0.5)');
  expect(document.querySelectorAll('.city-vehicle').length).toBeGreaterThan(0);
  expect(document.querySelectorAll('.city-person').length).toBeGreaterThan(0);
  expect(document.querySelectorAll('[data-city-layer] canvas')).toHaveLength(2);
  expect(city.querySelectorAll('polygon')).toHaveLength(0);
  expect(document.querySelector('[data-time-phase]')).toBeTruthy();
  expect(document.body.textContent).toContain('COMMITS');
  const beforeDrag = city.querySelector('[data-city-layer=buildings]')?.getAttribute('data-angle');
  const beforePan = city.querySelector('g')?.getAttribute('transform');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 180);
  expect(city.querySelector('[data-city-layer=buildings]')?.getAttribute('data-angle')).not.toBe(beforeDrag);
  expect(city.querySelector('g')?.getAttribute('transform')).toBe(beforePan);
  await pointer('pointerup', 180);
  const afterDrag = city.querySelector('[data-city-layer=buildings]')?.getAttribute('data-angle');
  await pointer('pointermove', 240);
  expect(city.querySelector('[data-city-layer=buildings]')?.getAttribute('data-angle')).toBe(afterDrag);
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  city.dispatchEvent(menu);
  expect(menu.defaultPrevented).toBe(true);
  await click('Ranking');
  expect(document.body.textContent).toContain('Ranking de Prefeitos');
  expect(document.body.textContent).toContain('Saia da demonstração');
  await click('Fechar painel');
  await click('Prefeito');
  expect(document.querySelector('.app')?.classList.contains('panel-gazette')).toBe(true);
  await click('Fechar painel');
  expect(document.querySelector('.app')?.classList.contains('panel-city')).toBe(true);
  const district = document.querySelector<HTMLButtonElement>('.district-row');
  await act(async () => {
    district?.click();
  });
  expect(document.querySelector('.district-row.selected')).toBeTruthy();
  const lastDistrict = [...document.querySelectorAll<HTMLButtonElement>('.district-row')].find((row) =>
    row.textContent?.includes('Extra 8'),
  );
  await act(async () => {
    lastDistrict?.click();
  });
  expect(document.querySelector('.district-marker.active')?.textContent).toContain('Extra 8');
  expect(document.querySelector('.map-pages')?.textContent).toContain('de ');
  const navigator = document.querySelector<HTMLSelectElement>('[aria-label="Ir para bairro"]');
  await act(async () => {
    if (!navigator) throw new Error('Missing district navigator');
    navigator.value = navigator.options[1].value;
    navigator.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(document.querySelector('.district-marker.active')).toBeTruthy();
  expect(document.querySelector('.map-pages')?.textContent).toContain('Bairros 1–8');
  await click('Configurações');
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  expect(document.body.textContent).toContain('Calendário de trabalho');
  expect(document.body.textContent).toContain('Feriados nacionais automáticos');
  expect(document.body.textContent).toContain('Pasta de sessões Claude Code');
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error('Falha ao salvar as preferências'));
  await click('Salvar configurações');
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    'Falha ao salvar as preferências',
  );
  await act(async () => {
    status.running = true;
    vi.mocked(api.onStatus).mock.lastCall?.[0](status);
  });
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeTruthy();
  expect(document.body.textContent).toContain('Você pode salvar');
  await click('Salvar configurações');
  expect(config.onboardingComplete).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.saveConfig).toHaveBeenCalledTimes(2);
  await act(async () => {
    status.running = false;
    vi.mocked(api.onStatus).mock.lastCall?.[0](status);
  });
  // A configured account still needs an import action when no PRs have arrived.
  await click('Configurações');
  await click('Sair do modo demo');
  await click('Verificar CLIs e descobrir organizações');
  await click('Salvar configurações');
  await click('Abrir histórico de importações');
  expect(document.querySelector('[aria-label="Histórico de importações"]')).toBeTruthy();
  await click('Fechar histórico');
  await click('Importar histórico');
  expect(api.sync).toHaveBeenCalledWith(true);
});
