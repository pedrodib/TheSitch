import { memo, useEffect, useRef } from 'react';
import { type Face, neon, type Point } from './city-model';

export type ProjectedFace = {
  points: [number, number][];
  color: string;
  repo?: string;
  ground?: boolean;
  depth: number;
  bounds: [number, number, number, number];
};

/** Project/sort only when geometry or rotation changes, never for zoom, pan or the clock. */
export function projectCity(faces: Face[], angle: number) {
  const sin = Math.sin(angle),
    cos = Math.cos(angle);
  const project = ([x, y, z]: Point): [number, number] => [
    600 + (x * cos - y * sin) * 1.32,
    465 + (x * sin + y * cos) * 0.66 - z * 1.32,
  ];
  const ground: ProjectedFace[] = [],
    buildings: ProjectedFace[] = [];
  for (const face of faces) {
    if (!face.ground && face.normal[0] * sin + face.normal[1] * cos + face.normal[2] * 0.5 <= 0) continue;
    const points = face.points.map(project);
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]);
    const projected: ProjectedFace = {
      points,
      color: face.color,
      repo: face.repo,
      ground: face.ground,
      depth: face.ground
        ? face.points[0][2]
        : face.points.reduce((sum, [x, y, z]) => sum + x * sin + y * cos + z * 0.02, 0) / face.points.length,
      bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    };
    (face.ground ? ground : buildings).push(projected);
  }
  ground.sort((a, b) => a.depth - b.depth);
  buildings.sort((a, b) => a.depth - b.depth);
  return { ground, buildings, project };
}

/** Native-resolution cached layers: moving sprites remain separate from static city geometry. */
export const CityLayer = memo(function CityLayer({
  faces,
  pan,
  zoom,
  selected,
  phase,
  angle,
  ground,
}: {
  faces: ProjectedFace[];
  pan: [number, number];
  zoom: number;
  selected: string | null;
  phase: string;
  angle: number;
  ground?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const svg = element.closest('svg');
    if (!svg) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      if (document.hidden) return;
      const bounds = svg.getBoundingClientRect();
      const ratio = Math.min(bounds.width / 1200, bounds.height / 800) * (window.devicePixelRatio || 1);
      if (ratio <= 0) return;
      const width = Math.ceil(1200 * ratio),
        height = Math.ceil(800 * ratio);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      const ctx = element.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const scale = zoom / 100;
      const tx = pan[0] + 600 * (1 - scale),
        ty = pan[1] + 400 * (1 - scale);
      ctx.setTransform(ratio * scale, 0, 0, ratio * scale, tx * ratio, ty * ratio);
      ctx.lineWidth = 0.35;
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      // Clip by the viewport before issuing draw commands; every visible face keeps its detail.
      const left = -tx / scale,
        top = -ty / scale,
        right = (1200 - tx) / scale,
        bottom = (800 - ty) / scale;
      let color = '',
        glow = '';
      const selectedColors = new Map<string, string>();
      for (const face of faces) {
        const [x1, y1, x2, y2] = face.bounds;
        if (x2 < left - 5 || x1 > right + 5 || y2 < top - 5 || y1 > bottom + 5) continue;
        let fill = face.color;
        if (face.repo === selected) {
          if (!selectedColors.has(fill))
            selectedColors.set(
              fill,
              '#' +
                [1, 3, 5]
                  .map((i) =>
                    Math.min(255, Math.round(Number.parseInt(fill.slice(i, i + 2), 16) * 1.12))
                      .toString(16)
                      .padStart(2, '0'),
                  )
                  .join(''),
            );
          fill = selectedColors.get(fill) ?? fill;
        }
        if (color !== fill) {
          ctx.fillStyle = fill;
          ctx.strokeStyle = fill;
          color = fill;
        }
        const nextGlow = ground && neon.includes(face.color) ? face.color : '';
        if (glow !== nextGlow) {
          ctx.shadowColor = nextGlow || 'transparent';
          ctx.shadowBlur = nextGlow ? 2.8 * ratio * scale : 0;
          glow = nextGlow;
        }
        ctx.beginPath();
        ctx.moveTo(...face.points[0]);
        for (let i = 1; i < face.points.length; i++) ctx.lineTo(...face.points[i]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(svg);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', schedule);
      cancelAnimationFrame(frame);
    };
  }, [faces, pan, zoom, selected, ground]);
  return (
    <foreignObject
      x="0"
      y="0"
      width="1200"
      height="800"
      pointerEvents="none"
      data-city-layer={ground ? 'ground' : 'buildings'}
      data-angle={angle}
    >
      <canvas
        ref={canvas}
        style={{
          width: 1200,
          height: 800,
          display: 'block',
          filter: ground
            ? undefined
            : phase === 'day'
              ? 'brightness(1.18) saturate(.85)'
              : phase === 'dawn' || phase === 'dusk'
                ? 'brightness(1.2)'
                : undefined,
        }}
      />
    </foreignObject>
  );
});
