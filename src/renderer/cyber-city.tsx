import { type Dispatch, memo, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import type { Contribution, Period, Repository } from '../shared/types';

import { buildCity, neon } from './city-model';
import { CityLayer, projectCity } from './city-renderer';

export function cityLight(date: Date, timezone: string) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(date)
      .split(':')[0],
  );
  return {
    phase:
      hour >= 7 && hour < 17
        ? 'day'
        : hour >= 17 && hour < 19
          ? 'dusk'
          : hour >= 5 && hour < 7
            ? 'dawn'
            : 'night',
    hour,
  };
}

/** Cached Canvas geometry with a lightweight SVG layer for traffic, labels and camera input. */
export const CyberCity = memo(function CyberCity({
  repos,
  contributions,
  selected,
  onSelect,
  zoom,
  onZoom,
  reducedMotion,
  replay,
  period,
  timezone,
  energy,
}: {
  repos: Repository[];
  contributions: Contribution[];
  selected: string | null;
  onSelect: (id: string) => void;
  zoom: number;
  onZoom: Dispatch<SetStateAction<number>>;
  reducedMotion: boolean;
  replay: number;
  period: Period;
  timezone: string;
  energy: number;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [now, setNow] = useState(() => new Date());
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(new Date());
    }, 30000);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => {
      clearInterval(timer);
      media.removeEventListener('change', update);
    };
  }, []);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1);
      onZoom((value) =>
        Math.max(50, Math.min(220, value * Math.exp(-Math.max(-160, Math.min(160, delta)) * 0.002))),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [onZoom]);
  const lighting = cityLight(now, timezone);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => {
      setVisible(!document.hidden);
      if (!document.hidden) setNow(new Date());
    };
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const animate = !reducedMotion && !systemReducedMotion && visible;
  const [angle, setAngle] = useState(-0.72);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const drag = useRef<{
    pointerId: number;
    mode: 'pan' | 'rotate';
    x: number;
    y: number;
    angle: number;
  } | null>(null);
  const first = Date.parse(`${period.start}T12:00:00Z`);
  const last = Date.parse(`${period.end}T12:00:00Z`);
  const cutoff = new Date(first + Math.floor(((last - first) * replay) / 100 / 86400000) * 86400000)
    .toISOString()
    .slice(0, 10);
  const model = useMemo(
    () => buildCity(repos, contributions, period, cutoff, timezone, replay < 100),
    [repos, contributions, cutoff, period, timezone, replay],
  );
  const projected = useMemo(() => projectCity(model.faces, angle), [model, angle]);
  const project = projected.project;
  return (
    <div
      className={`map-scroll cyber-scene time-${lighting.phase}`}
      data-replay-date={cutoff}
      data-time-phase={lighting.phase}
    >
      <svg
        ref={svg}
        className="city"
        viewBox="0 0 1200 800"
        role="img"
        aria-label="Cidade cyberpunk tridimensional. Scroll para zoom, arraste o fundo para mover e use o botão direito para girar."
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          const rotate = e.button === 2;
          const ground = e.target === e.currentTarget || (e.target as Element).closest('.city-ground');
          if (drag.current || (!rotate && (e.button !== 0 || !ground))) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            pointerId: e.pointerId,
            mode: rotate ? 'rotate' : 'pan',
            x: rotate ? e.clientX : e.clientX - pan[0],
            y: e.clientY - pan[1],
            angle,
          };
        }}
        onPointerMove={(e) => {
          const gesture = drag.current;
          if (!gesture || gesture.pointerId !== e.pointerId) return;
          if (gesture.mode === 'rotate') setAngle(gesture.angle + (e.clientX - gesture.x) * 0.008);
          else setPan([e.clientX - gesture.x, e.clientY - gesture.y]);
        }}
        onPointerUp={(e) => {
          if (drag.current?.pointerId !== e.pointerId) return;
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <defs>
          <filter id="neon-glow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="1.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="city-sky">
            <stop className="sky-center" stopColor="#51415e" />
            <stop className="sky-edge" offset="1" stopColor="#19182d" />
          </radialGradient>
        </defs>
        <rect className="city-ground" x="-2000" y="-2000" width="5000" height="5000" fill="url(#city-sky)" />
        <CityLayer
          ground
          faces={projected.ground}
          pan={pan}
          zoom={zoom}
          selected={selected}
          phase={lighting.phase}
          angle={angle}
        />
        <g
          transform={`translate(${pan[0]} ${pan[1]}) translate(600 400) scale(${zoom / 100}) translate(-600 -400)`}
        >
          {model.traffic.map(({ start, end }, i) => {
            const [sx, sy] = project(start),
              [ex, ey] = project(end);
            return (
              <g
                key={`vehicle-${start.join(':')}`}
                className="city-vehicle"
                transform={
                  !animate
                    ? `translate(${sx + (ex - sx) * (i / model.traffic.length)} ${sy + (ey - sy) * (i / model.traffic.length)})`
                    : undefined
                }
              >
                {animate && (
                  <animateMotion
                    path={`M${sx},${sy} L${ex},${ey}`}
                    dur={`${18 + (i % 4) * 3}s`}
                    begin={`${-i * 4}s`}
                    repeatCount="indefinite"
                  />
                )}
                <ellipse rx="5" ry="2" fill={neon[i % 4]} opacity=".18" />
                <path d="M-4 0l2-2h5l2 2-2 2h-5z" fill="#304d69" stroke={neon[i % 4]} strokeWidth=".8" />
                <path d="M-1-1h3" stroke="#b1faff" strokeWidth="2" />
              </g>
            );
          })}
          {model.walks.flatMap(({ repo, start, end, pedestrians }, i) =>
            Array.from({ length: pedestrians }, (_, j) => j).map((j) => {
              const [sx, sy] = project(start),
                [ex, ey] = project(end);
              return (
                <g
                  key={`${repo}-person-${j}`}
                  className="city-person"
                  transform={
                    !animate
                      ? `translate(${sx + ((ex - sx) * j) / 5} ${sy + ((ey - sy) * j) / 5})`
                      : undefined
                  }
                >
                  {animate && (
                    <animateMotion
                      path={`M${sx},${sy} L${ex},${ey} L${sx},${sy}`}
                      dur={`${35 + j * 5}s`}
                      begin={`${-j * 9}s`}
                      repeatCount="indefinite"
                    />
                  )}
                  <ellipse rx="3" ry="1.2" fill="#050b18" opacity=".6" />
                  <path d="M-1 0v-4h2v4" stroke={neon[(i + j) % 4]} strokeWidth="1.4" />
                  <circle cy="-6" r="1.4" fill="#d8dfed" />
                </g>
              );
            }),
          )}
        </g>
        <CityLayer
          faces={projected.buildings}
          pan={pan}
          zoom={zoom}
          selected={selected}
          phase={lighting.phase}
          angle={angle}
        />
        <g
          transform={`translate(${pan[0]} ${pan[1]}) translate(600 400) scale(${zoom / 100}) translate(-600 -400)`}
        >
          {model.labels.map(({ repo, point, count, commits, works, stage }) => {
            const [x, y] = project(point);
            return (
              <foreignObject key={repo.id} x={x - 76} y={y + 10} width="152" height="45">
                <button
                  type="button"
                  className={`district-marker ${selected === repo.id ? 'active' : ''}`}
                  onClick={() => onSelect(repo.id)}
                  title={`${repo.fullName} · ${stage} · ${count} atividades no período`}
                >
                  <span>{repo.name}</span>
                  <small>
                    {works} obras acumuladas · {commits} commits
                  </small>
                </button>
              </foreignObject>
            );
          })}
        </g>
      </svg>
      <div className="city-clock">
        <span className="clock-dot" />
        {new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(
          now,
        )}{' '}
        / {{ day: 'DIA', dawn: 'AMANHECER', dusk: 'ANOITECER', night: 'NOITE' }[lighting.phase]}
        <small>{timezone} · ciclo em tempo real</small>
      </div>
      <div className="city-legend">
        ▦ Módulos neon = commits <span>Até 18 módulos por bairro · total exato na etiqueta</span>
        <span>
          Altura e ocupação refletem todo o histórico importado · filtro altera os indicadores · veículos e
          pessoas são ambientação
        </span>
      </div>
      <div className="camera-controls">
        <span>◈ CÂMERA / DISTRITO</span>
        <button type="button" aria-label="Girar cidade à esquerda" onClick={() => setAngle(angle - 0.25)}>
          ↶
        </button>
        <button type="button" aria-label="Girar cidade à direita" onClick={() => setAngle(angle + 0.25)}>
          ↷
        </button>
        <button
          type="button"
          onClick={() => {
            setAngle(-0.72);
            setPan([0, 0]);
            onZoom(100);
          }}
        >
          Centralizar
        </button>
        <small>
          Scroll: zoom · Direito: girar · Esquerdo: mover
          <br />
          {energy > 0 ? 'Rede em atividade' : 'Rede em espera'}
        </small>
      </div>
    </div>
  );
});
