// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/backend/demo';
import { buildCity } from '../src/renderer/city-model';
import { CityLayer, type ProjectedFace, projectCity } from '../src/renderer/city-renderer';
import { defaultConfig } from '../src/shared/defaults';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([-0.72, 0, 1.5, 3.14])(
  'preserves every visible face and original painter ordering at rotation %s',
  (angle) => {
    const demo = createDemoData(defaultConfig('/tmp'));
    const model = buildCity(
      demo.repositories,
      demo.contributions,
      { start: '2026-01-01', end: '2026-12-31' },
      '2026-12-31',
      'UTC',
    );
    const result = projectCity(model.faces, angle);
    const expected = model.faces
      .filter(
        (f) =>
          !f.ground && f.normal[0] * Math.sin(angle) + f.normal[1] * Math.cos(angle) + f.normal[2] * 0.5 > 0,
      )
      .sort(
        (a, b) =>
          a.points.reduce((s, [x, y, z]) => s + x * Math.sin(angle) + y * Math.cos(angle) + z * 0.02, 0) /
            a.points.length -
          b.points.reduce((s, [x, y, z]) => s + x * Math.sin(angle) + y * Math.cos(angle) + z * 0.02, 0) /
            b.points.length,
      );
    expect(result.ground).toHaveLength(model.faces.filter((f) => f.ground).length);
    expect(result.buildings.map((f) => [f.color, f.points])).toEqual(
      expected.map((f) => [
        f.color,
        f.points.map(([x, y, z]) => [
          600 + (x * Math.cos(angle) - y * Math.sin(angle)) * 1.32,
          465 + (x * Math.sin(angle) + y * Math.cos(angle)) * 0.66 - z * 1.32,
        ]),
      ]),
    );
  },
);
it('draws at Retina resolution, reuses idle layers and suspends hidden draws', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  let pending: FrameRequestCallback | undefined;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      pending = callback;
      return 1;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => {
      pending = undefined;
    }),
  );
  const flush = () => {
    const callback = pending;
    pending = undefined;
    callback?.(0);
  };
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1200,
    height: 800,
  } as DOMRect);
  const faces: ProjectedFace[] = [
    {
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      color: '#123456',
      bounds: [0, 0, 10, 10],
      depth: 0,
    },
    {
      points: [
        [2000, 0],
        [2010, 0],
        [2010, 10],
        [2000, 10],
      ],
      color: '#123456',
      bounds: [2000, 0, 2010, 10],
      depth: 0,
    },
  ];
  const pan: [number, number] = [0, 0];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (zoom = 100) =>
    act(async () =>
      root.render(
        <svg role="img" aria-label="Cena de teste">
          <CityLayer faces={faces} pan={pan} zoom={zoom} selected={null} phase="night" angle={0} />
        </svg>,
      ),
    );
  try {
    await render();
    flush();
    expect(host.querySelector('canvas')?.width).toBe(2400);
    expect(host.querySelector('canvas')?.height).toBe(1600);
    expect(ctx.fill).toHaveBeenCalledTimes(1); // off-screen geometry never reaches the rasterizer
    await render();
    expect(pending).toBeUndefined();
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    await render(120);
    flush();
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2.4, 0, 0, 2.4, expect.any(Number), expect.any(Number));
    const count = ctx.clearRect.mock.calls.length;
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    flush();
    expect(ctx.clearRect).toHaveBeenCalledTimes(count);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    flush();
    expect(ctx.clearRect).toHaveBeenCalledTimes(count + 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
