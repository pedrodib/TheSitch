import { createHash } from 'node:crypto';
import { createGithubApi, type GithubApi } from '../integrations/github-api';
import type { MayorRanking, Period } from '../shared/types';
import type { Store } from './store';

type Item = { id: number; user: { login: string; type: string } | null; repository_url: string };
type Search = { total_count: number; incomplete_results: boolean; items: Item[] };
type Day = { at: string; counts: Record<string, number>; repos: string[] };
type Chunk = { from: string; to: string };
const hour = 3600000;
const dayMs = 24 * hour;
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
class Budget extends Error {}

/** A separate, bounded cache of organizational counts; never imports peers into the user's city. */
export class MayorLeague {
  running = false;
  phase = 'Aguardando primeira consulta';
  error: string | null = null;
  private abort?: AbortController;
  private closed = false;
  private period: Period | null = null;
  private activeScope = '';
  constructor(
    private store: Store,
    private makeApi = createGithubApi,
  ) {}
  private config() {
    const config = this.store.getConfig();
    return { ...config, organizations: [...new Set(config.organizations.map((org) => org.toLowerCase()))] };
  }
  private scope(config = this.config()) {
    return `league:${digest(JSON.stringify([config.workspace.id, config.githubHost, [...config.organizations].sort(), config.workspace.members.map((m) => m.externalLogin)]))}:`;
  }
  private days(period: Period) {
    const result: string[] = [];
    const end = Math.min(Date.parse(period.end), Date.now());
    for (
      let date = end - (end % dayMs);
      date >= Math.max(Date.parse(period.start), Date.parse('2026-01-01'));
      date -= dayMs
    )
      result.push(new Date(date).toISOString().slice(0, 10));
    return result;
  }
  interval(value?: number) {
    if (value !== undefined) {
      if (![1, 2, 3].includes(value)) throw new Error('Escolha 1, 2 ou 3 horas.');
      this.store.setState('league:hours', value);
    }
    return this.store.getState<number>('league:hours') ?? 2;
  }
  cancel() {
    this.abort?.abort();
  }
  close() {
    this.closed = true;
    this.cancel();
  }
  view(period: Period): MayorRanking {
    if (period.rolling)
      period = {
        start: new Date(Date.now() - 29 * dayMs).toISOString().slice(0, 10),
        end: new Date().toISOString().slice(0, 10),
        rolling: true,
      };
    this.period = period;
    const config = this.config(),
      scope = this.scope(config);
    const refresh = this.store.getState<{ start: string; end: string; at: number }>(`${scope}refresh`);
    const days = this.days(period),
      totals = new Map<string, number>(),
      repos = new Set<string>();
    let completed = 0;
    const dates: string[] = [];
    for (const org of config.organizations)
      for (const day of days) {
        const saved = this.store.getState<Day>(`${scope}${org}:${day}`);
        if (!saved) continue;
        if (!refresh || day < refresh.start || day > refresh.end || Date.parse(saved.at) >= refresh.at)
          completed++;
        dates.push(saved.at);
        for (const [login, n] of Object.entries(saved.counts))
          totals.set(login, (totals.get(login) ?? 0) + n);
        for (const repo of saved.repos) repos.add(repo);
      }
    const me = config.workspace.members[0]?.externalLogin.toLowerCase();
    const values = [...totals.values()].sort((a, b) => a - b);
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const median = values.length
      ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
      : 0;
    const rows = [...totals]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([login, merged], i, all) => ({
        login,
        merged,
        rank: i > 0 && all[i - 1][1] === merged ? all.findIndex((row) => row[1] === merged) + 1 : i + 1,
        me: login === me,
      }));
    const mine = totals.get(me ?? '') ?? 0;
    const last = this.store.getState<number>(`${scope}attempt`);
    return {
      period,
      organizations: config.organizations,
      intervalHours: this.interval(),
      running: this.running && this.activeScope === scope,
      phase: this.activeScope === scope ? this.phase : 'Aguardando próxima consulta',
      error: this.store.getState<string>(`${scope}error`),
      checkedAt: dates.length ? dates.sort()[0] : null,
      nextAt: last ? new Date(last + this.interval() * hour).toISOString() : null,
      completedDays: completed,
      totalDays: days.length * config.organizations.length,
      repositories: repos.size,
      partial:
        completed < days.length * config.organizations.length ||
        !!this.store.getState<string>(`${scope}error`),
      rows,
      mean,
      median,
      mine,
      difference: mean ? (mine / mean - 1) * 100 : null,
    };
  }
  async tick(blocked = false, force = false): Promise<void> {
    if (blocked) {
      if (!this.running && !this.closed) {
        this.activeScope = this.scope();
        this.phase = 'Aguardando: importações pessoais têm prioridade ou coleta pausada';
      }
      return;
    }
    if (this.running || this.closed || !this.period) return;
    const config = this.config();
    if (!config.onboardingComplete || !config.organizations.length) return;
    const scope = this.scope(config),
      now = Date.now();
    if (!force && now - (this.store.getState<number>(`${scope}attempt`) ?? 0) < this.interval() * hour)
      return;
    this.store.setState(`${scope}attempt`, now);
    this.activeScope = scope;
    this.running = true;
    this.error = null;
    this.store.setState(`${scope}error`, null);
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(
      () => abort.abort(new Error('Rodada limitada a 3 minutos; retomada no próximo ciclo.')),
      180000,
    );
    const period = this.view(this.period).period;
    if (force) {
      this.store.setState(`${scope}refresh`, { start: period.start, end: period.end, at: now });
      this.store.deleteStatePrefix(`${scope}pending:`);
    }
    const refresh = this.store.getState<{ start: string; end: string; at: number }>(`${scope}refresh`);
    let requests = 0;
    const valid = () => {
      abort.signal.throwIfAborted();
      if (this.closed || this.scope() !== scope)
        throw new Error('Configuração alterada; consulta interrompida.');
    };
    const api = this.makeApi(
      config,
      (message) => {
        this.phase = message;
      },
      abort.signal,
    );
    const fetch: GithubApi = async (endpoint) => {
      valid();
      if (requests >= 20)
        throw new Budget('Limite de 20 consultas por rodada; progresso salvo para o próximo ciclo.');
      requests++;
      return api(endpoint);
    };
    try {
      // Fill missing days before refreshing snapshots, so a large first import cannot starve.
      const tasks = config.organizations.flatMap((org) =>
        this.days(period).map((day) => ({
          org,
          day,
          saved: this.store.getState<Day>(`${scope}${org}:${day}`),
        })),
      );
      tasks.sort((a, b) => Number(!!a.saved) - Number(!!b.saved));
      for (const { org, day, saved } of tasks) {
        valid();
        const recent = Date.parse(day) >= now - 2 * dayMs;
        const requested =
          refresh &&
          day >= refresh.start &&
          day <= refresh.end &&
          (!saved || Date.parse(saved.at) < refresh.at);
        if (saved && !requested && now - Date.parse(saved.at) < (recent ? this.interval() * hour : 7 * dayMs))
          continue;
        this.phase = `Conferindo ${org} · ${day} (UTC) · ${requests}/20 consultas`;
        const prefix = `${scope}pending:${org}:${day}:`;
        const chunks = this.store.getState<Chunk[]>(`${prefix}chunks`) ?? [
          { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` },
        ];
        const items: Item[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const key = `${prefix}${chunk.from}:${chunk.to}:`;
          const page = async (n: number): Promise<Search> => {
            const cached = this.store.getState<Search>(key + n);
            if (cached) return cached;
            const query = `is:pr is:merged org:${org} merged:${chunk.from}..${chunk.to}`;
            const result = (await fetch(
              `search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${n}&sort=created&order=asc`,
            )) as Search;
            valid();
            if (
              result.incomplete_results ||
              !Array.isArray(result.items) ||
              !Number.isInteger(result.total_count)
            )
              throw new Error('GitHub retornou uma busca incompleta.');
            const compact: Search = {
              total_count: result.total_count,
              incomplete_results: false,
              items: result.items.map((item) => ({
                id: item.id,
                user: item.user ? { login: item.user.login, type: item.user.type } : null,
                repository_url: item.repository_url,
              })),
            };
            this.store.setState(key + n, compact);
            return compact;
          };
          const first = await page(1);
          if (first.total_count > 1000) {
            const start = Date.parse(chunk.from),
              end = Date.parse(chunk.to);
            if (end - start < 1000)
              throw new Error('Volume excede o limite do GitHub neste intervalo. Cobertura parcial.');
            const middle = Math.floor((start + end) / 2000) * 1000;
            chunks.splice(
              i,
              1,
              { from: chunk.from, to: new Date(middle).toISOString().replace('.000', '') },
              { from: new Date(middle + 1000).toISOString().replace('.000', ''), to: chunk.to },
            );
            this.store.setState(`${prefix}chunks`, chunks);
            i--;
            continue;
          }
          const batch = [...first.items];
          for (let n = 2; n <= Math.ceil(first.total_count / 100); n++) {
            const result = await page(n);
            if (result.total_count !== first.total_count)
              throw new Error('Resultados mudaram durante a paginação; o dia será repetido.');
            batch.push(...result.items);
          }
          if (
            new Set(batch.map((item) => item.id)).size !== first.total_count ||
            batch.length !== first.total_count
          )
            throw new Error('Paginação divergente; o dia será repetido.');
          items.push(...batch);
        }
        const counts: Record<string, number> = Object.create(null),
          repos = new Set<string>();
        for (const item of new Map(items.map((item) => [item.id, item])).values()) {
          if (!item.user || item.user.type === 'Bot' || item.user.login.endsWith('[bot]')) continue;
          const login = item.user.login.toLowerCase();
          counts[login] = (counts[login] ?? 0) + 1;
          repos.add(item.repository_url);
        }
        valid();
        this.store.setState(`${scope}${org}:${day}`, {
          at: new Date().toISOString(),
          counts,
          repos: [...repos],
        });
        this.store.deleteStatePrefix(prefix);
      }
      this.phase = 'Consulta concluída · PRs mergeados nos repositórios acessíveis';
    } catch (error) {
      if (!this.closed && this.scope() === scope) {
        this.error = error instanceof Error ? error.message : 'Falha ao consultar ranking';
        this.store.setState(`${scope}error`, this.error);
        this.phase = 'Progresso preservado; nova tentativa no próximo ciclo';
        // Budget stops retain successful pages; inconsistent/failed snapshots are re-read.
        if (!(error instanceof Budget) && /incompleta|mudaram|divergente/.test(this.error))
          this.store.deleteStatePrefix(`${scope}pending:`);
      }
    } finally {
      clearTimeout(timeout);
      this.running = false;
      this.abort = undefined;
    }
  }
}
