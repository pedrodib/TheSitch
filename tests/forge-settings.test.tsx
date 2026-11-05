// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ForgeSettings } from '../src/renderer/forge-settings';
import { defaultConfig } from '../src/shared/defaults';
import type { TheSitchApi } from '../src/shared/types';

it('exposes provider configuration and checks saved credentials without requesting a token in the renderer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.theSitch = {
    diagnostics: vi.fn(async () => [{ source: 'gitlab', message: 'Conta GitLab autenticada.' }]),
  } as unknown as TheSitchApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Form() {
    const [config, setConfig] = useState(defaultConfig('/tmp'));
    return (
      <ForgeSettings
        config={config}
        update={(patch) => setConfig((previous) => ({ ...previous, ...patch }))}
      />
    );
  }
  try {
    await act(async () => {
      root.render(<Form />);
    });
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[type=checkbox]')?.click();
    });
    expect(host.textContent).toContain('Projetos GitLab');
    expect(host.textContent).toContain('glab auth login');
    await act(async () => {
      host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1].click();
    });
    expect(host.textContent).toContain('Arquivo do API token Bitbucket');
    expect(host.querySelector('input[type=password]')).toBeNull();
    await act(async () => {
      host.querySelector('button')?.click();
    });
    expect(window.theSitch.diagnostics).toHaveBeenCalledOnce();
    expect(host.querySelector('[role=status]')?.textContent).toContain('Conta GitLab autenticada.');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
