// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CustomPeriod } from '../src/renderer/custom-period';
import { isValidPeriod } from '../src/shared/period';

it('holds empty and reversed date edits locally until a valid range is applied', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const edit = async (label: string, value: string) =>
    act(async () => {
      const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(<CustomPeriod value={{ start: '2026-10-01', end: '2026-11-05' }} onChange={onChange} />),
    );
    for (const label of ['Data inicial', 'Data final']) {
      await edit(label, '');
      expect(host.querySelector('button')?.disabled).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
    }
    await edit('Data inicial', '2026-12-01');
    await edit('Data final', '2026-11-05');
    expect(host.querySelector('button')?.disabled).toBe(true);
    await edit('Data inicial', '2026-09-01');
    expect(host.querySelector('button')?.disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ start: '2026-09-01', end: '2026-11-05' });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
it.each([
  ['', '2026-11-05', false],
  ['2026-02-30', '2026-11-05', false],
  ['2026-12-01', '2026-11-05', false],
  ['2000-01-01', '2026-11-05', false],
  ['2024-02-29', '2024-03-01', true],
  ['2026-11-05', '2026-11-05', true],
])('validates %s through %s as %s before rendering or IPC', (start, end, valid) => {
  expect(isValidPeriod({ start, end })).toBe(valid);
});
