import { deliveryKey, inPeriod, localDate } from '../shared/contributions';
import type {
  AppConfig,
  Assessment,
  Contribution,
  Dashboard,
  Metrics,
  Period,
  Repository,
  SyncStatus,
  TokenUsage,
} from '../shared/types';

const shift = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const dates = (start: string, end: string): string[] => {
  const result: string[] = [];
  for (let d = start; d <= end; d = shift(d, 1)) result.push(d);
  return result;
};
export function previousPeriod(period: Period): Period {
  const span = dates(period.start, period.end).length;
  if (period.rolling) return { start: shift(period.start, -span), end: shift(period.end, -span) };
  if (period.start.slice(8) === '01' && period.start.slice(0, 7) === period.end.slice(0, 7) && span > 1) {
    const last = new Date(`${period.start}T12:00:00Z`);
    last.setUTCDate(0);
    const prefix = last.toISOString().slice(0, 8);
    const endDay = Math.min(Number(period.end.slice(8)), last.getUTCDate());
    return { start: `${prefix}01`, end: `${prefix}${String(endDay).padStart(2, '0')}` };
  }
  const offset = span <= 7 && new Date(`${period.start}T12:00:00Z`).getUTCDay() === 1 ? 7 : span;
  return { start: shift(period.start, -offset), end: shift(period.end, -offset) };
}
export function dateInTimezone(value: string | Date, timezone: string): string {
  return localDate(value, timezone);
}
function easter(year: number): string {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function isBusinessDay(date: string, calendar: AppConfig['calendar']): boolean {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (
    !calendar.workdays.includes(weekday) ||
    calendar.excludedDates.includes(date) ||
    date in calendar.holidays
  )
    return false;
  if (calendar.automaticHolidays) {
    if (date in (calendar.automaticHolidayDates ?? {})) return false;
    const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
    const pascha = easter(Number(date.slice(0, 4)));
    if (fixed.includes(date.slice(5)) || date === shift(pascha, -2)) return false;
  }
  return true;
}
function delivery(item: Contribution): boolean {
  return (
    (item.kind === 'pull_request' || (item.kind === 'commit' && !item.associatedPullRequests?.length)) &&
    (item.state === 'merged' || item.state === 'deployed')
  );
}
function deliveryDates(items: Contribution[], timezone: string): string[] {
  const groups = new Map<string, string>();
  for (const item of items.filter(delivery)) {
    const key = deliveryKey(item);
    const date = dateInTimezone(item.mergedAt ?? item.deployedAt ?? item.occurredAt, timezone);
    if (!groups.has(key) || date > (groups.get(key) ?? '')) groups.set(key, date);
  }
  return [...groups.values()];
}
function calculate(
  config: AppConfig,
  contributions: Contribution[],
  tokens: TokenUsage[],
  period: Period,
  baselineRate: number | null,
  today: string,
  dateOf: (value: string) => string,
): Metrics {
  const items = contributions.filter((c) => {
    const d = dateOf(c.occurredAt);
    return d >= period.start && d <= period.end;
  });
  const usage = tokens.filter((t) => {
    const d = dateOf(t.occurredAt);
    return d >= period.start && d <= period.end;
  });
  const completed = deliveryDates(contributions, config.calendar.timezone).filter(
    (d) => d >= period.start && d <= period.end,
  );
  const allDates = dates(period.start, period.end);
  const completeDays = allDates.filter((d) => d < today && isBusinessDay(d, config.calendar));
  const rhythmDeliveries = completed.filter((d) => d < today && isBusinessDay(d, config.calendar));
  const currentRate = completeDays.length ? rhythmDeliveries.length / completeDays.length : null;
  const daily = allDates.map((date) => ({
    date,
    deliveries: 0,
    reviews: 0,
    tokens: 0,
    businessDay: isBusinessDay(date, config.calendar),
  }));
  const buckets = new Map(daily.map((day) => [day.date, day]));
  for (const date of completed) {
    const day = buckets.get(date);
    if (day) day.deliveries += 1;
  }
  for (const item of items) {
    const day = buckets.get(dateOf(item.occurredAt));
    if (day && item.kind === 'review') day.reviews += 1;
  }
  for (const token of usage) {
    const day = buckets.get(dateOf(token.occurredAt));
    if (day && token.repositoryId && !token.isTheSitch) day.tokens += token.total;
  }
  return {
    deliveries: completed.length,
    pullRequests: items.filter((c) => c.kind === 'pull_request').length,
    commits: new Set(items.filter((c) => c.kind === 'commit').map((c) => c.externalId)).size,
    reviews: items.filter((c) => c.kind === 'review').length,
    activeWorks: items.filter(
      (c) =>
        (c.kind === 'pull_request' || c.kind === 'work_item') &&
        (c.state === 'building' || c.state === 'inspection'),
    ).length,
    deployed: new Set(
      contributions
        .filter(
          (c) => c.deployedAt && dateOf(c.deployedAt) >= period.start && dateOf(c.deployedAt) <= period.end,
        )
        .map(deliveryKey),
    ).size,
    tokens: usage.filter((t) => !t.isTheSitch && t.repositoryId).reduce((sum, t) => sum + t.total, 0),
    unassignedTokens: usage
      .filter((t) => !t.isTheSitch && !t.repositoryId)
      .reduce((sum, t) => sum + t.total, 0),
    analysisTokens: usage.filter((t) => t.isTheSitch).reduce((sum, t) => sum + t.total, 0),
    tokensByProvider: {
      codex: usage
        .filter((t) => !t.isTheSitch && (t.provider ?? 'codex') === 'codex')
        .reduce((sum, t) => sum + t.total, 0),
      claude: usage
        .filter((t) => !t.isTheSitch && t.provider === 'claude')
        .reduce((sum, t) => sum + t.total, 0),
    },
    businessDays: allDates.filter((d) => isBusinessDay(d, config.calendar)).length,
    baselineRate,
    currentRate,
    changePercent:
      baselineRate !== null && baselineRate > 0 && currentRate !== null
        ? (currentRate / baselineRate - 1) * 100
        : null,
    daily,
  };
}
export function buildDashboard(
  config: AppConfig,
  repositories: Repository[],
  contributions: Contribution[],
  tokens: TokenUsage[],
  status: SyncStatus,
  period: Period,
  demo: boolean,
): Dashboard {
  // Both periods and daily buckets reuse conversions; release the cache after this projection.
  const dateCache = new Map<string, string>();
  const dateOf = (value: string) => {
    let date = dateCache.get(value);
    if (date === undefined) {
      date = dateInTimezone(value, config.calendar.timezone);
      dateCache.set(value, date);
    }
    return date;
  };
  const today = dateInTimezone(new Date(), config.calendar.timezone);
  const days: string[] = [];
  for (let d = shift(period.start, -1); days.length < 60 && d >= shift(period.start, -400); d = shift(d, -1))
    if (d < today && isBusinessDay(d, config.calendar)) days.push(d);
  const coverageStart = status.coverageStart?.slice(0, 10) ?? null;
  const covered = status.coverageComplete && coverageStart ? days.filter((d) => d >= coverageStart) : [];
  const baselineCount = deliveryDates(contributions, config.calendar.timezone).filter((d) =>
    covered.includes(d),
  ).length;
  const baselineRate = covered.length >= 10 ? baselineCount / covered.length : null;
  const metrics = calculate(config, contributions, tokens, period, baselineRate, today, dateOf);
  const previous = previousPeriod(period);
  const previousMetrics = calculate(config, contributions, tokens, previous, null, today, dateOf);
  const provisional = period.start <= today && period.end >= today;
  let rhythm: Assessment['rhythm'] = 'insufficient';
  if (!metrics.businessDays) rhythm = 'neutral';
  else if (
    baselineRate !== null &&
    baselineRate > 0 &&
    metrics.currentRate !== null &&
    status.coverageComplete &&
    coverageStart !== null &&
    coverageStart <= period.start
  ) {
    rhythm =
      metrics.currentRate > baselineRate * 1.2
        ? 'above'
        : metrics.currentRate < baselineRate * 0.8
          ? 'below'
          : 'usual';
  }
  const evidenceIds = contributions
    .filter((c) => {
      return inPeriod(c, period, config.calendar.timezone);
    })
    .slice(0, 5)
    .map((c) => c.id);
  const assessment: Assessment = {
    headline:
      rhythm === 'neutral'
        ? 'A prefeitura também descansa'
        : rhythm === 'insufficient'
          ? 'Aguardando mais atas'
          : rhythm === 'above'
            ? 'A máquina pública está acelerada'
            : rhythm === 'below'
              ? 'O expediente está mais tranquilo'
              : 'Expediente dentro do costume',
    summary: `${metrics.deliveries} entregas e ${metrics.reviews} revisões registradas no período.`,
    caveat:
      'Contagens descrevem registros disponíveis, não medem impacto ou qualidade. Fins de semana não entram no ritmo.',
    priority:
      rhythm === 'insufficient'
        ? 'Sincronize mais histórico para comparar o ritmo.'
        : 'Confira as evidências antes de tirar conclusões.',
    rhythm,
    confidence: covered.length >= 40 ? 'high' : covered.length >= 10 ? 'moderate' : 'low',
    evidenceIds,
    source: 'local',
    provisional,
  };
  return {
    workspace: config.workspace,
    repositories,
    contributions,
    metrics,
    previousMetrics,
    assessment,
    status,
    period,
    demo,
  };
}
