import type { Dashboard } from '../shared/types';

/** Alert levels describe delivery pace against personal history, never employee worth. */
export function mayorLevel(dashboard: Dashboard | null): number | null {
  if (
    !dashboard?.status.coverageComplete ||
    dashboard.metrics.businessDays === 0 ||
    dashboard.metrics.baselineRate === null ||
    dashboard.metrics.baselineRate <= 0 ||
    dashboard.metrics.currentRate === null ||
    !dashboard.status.coverageStart ||
    dashboard.status.coverageStart.slice(0, 10) > dashboard.period.start
  )
    return null;
  const change = dashboard.metrics.changePercent;
  if (change === null) return null;
  return change > 20 ? 5 : change >= -20 ? 4 : change >= -40 ? 3 : change >= -60 ? 2 : 1;
}
export function MayorMeter({ dashboard, onOpen }: { dashboard: Dashboard | null; onOpen: () => void }) {
  const level = mayorLevel(dashboard);
  const labels: Record<number, string> = {
    5: 'EM ALTA',
    4: 'ESTÁVEL',
    3: 'ATENÇÃO',
    2: 'ALERTA',
    1: 'CRÍTICO',
  };
  const neutral = dashboard?.metrics.businessDays === 0;
  return (
    <button
      type="button"
      className="mayor-meter"
      data-level={level ?? 'neutral'}
      onClick={onOpen}
      aria-label={`Prefeitômetro: ${level ? `nível ${level}, ${labels[level]}` : neutral ? 'descanso' : 'calibrando'}`}
      title="Ritmo de entregas por dia útil vs. seu histórico. Níveis: acima de +20%, até −20%, até −40%, até −60% e abaixo de −60%. Não mede qualidade ou impacto."
    >
      <span className="meter-caption">PREFEITÔMETRO / STATUS</span>
      <div className="meter-reading">
        <strong>{level ?? '—'}</strong>
        <span>
          {level ? labels[level] : neutral ? 'DESCANSO' : 'CALIBRANDO'}
          <small>
            {level ? 'RITMO DE ENTREGAS' : neutral ? 'DIAS NÃO ÚTEIS · NEUTRO' : 'AGUARDANDO BASE CONFIÁVEL'}
          </small>
        </span>
      </div>
      <div className="meter-scale">
        {[5, 4, 3, 2, 1].map((n) => (
          <i key={n} data-active={level === n} data-severity={n}>
            {n}
          </i>
        ))}
      </div>
      <small>{dashboard?.assessment.provisional ? 'Período em aberto · ' : ''}Ver avaliação →</small>
    </button>
  );
}
