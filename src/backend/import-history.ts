import { createHash, randomUUID } from 'node:crypto';
import { HISTORY_START } from '../shared/defaults';
import type { ImportHistory, ImportRun, IntegrationContext, Source } from '../shared/types';
import type { Store } from './store';

const sources: Source[] = ['codex', 'claude', 'github', 'gitlab', 'bitbucket', 'azure'];
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Persists a frozen import attempt and caches successful reads for idempotent retry. */
export class ImportJournal {
  constructor(private store: Store) {}
  recover(): void {
    for (const source of sources) {
      const run = this.current(source);
      if (run && (run.state === 'running' || run.state === 'waiting')) {
        run.state = 'interrupted';
        run.finishedAt = new Date().toISOString();
        run.phase = 'Aplicativo encerrado durante a coleta. Retomada disponível.';
        this.save(run);
      }
    }
  }
  current(source: Source): ImportRun | null {
    return this.store.getState(`import:${source}:current`);
  }
  save(run: ImportRun): void {
    this.store.setState(`import:${run.source}:current`, run);
  }
  begin(source: Source, full: boolean): ImportRun {
    const old = this.current(source);
    if (old && old.state !== 'complete') {
      const recent = this.store.getState<ImportRun[]>(`import:${source}:recent`) ?? [];
      if (old.finishedAt)
        this.store.setState(`import:${source}:recent`, [structuredClone(old), ...recent].slice(0, 20));
      // Drop obsolete pre-2026 windows while retaining verified work in scope.
      old.steps = old.steps.filter((step) => !step.to || step.to >= HISTORY_START.slice(0, 10));
      if (old.since && old.since < HISTORY_START) old.since = HISTORY_START;
      old.finishedAt = null;
      this.store.deleteStatePrefix(`import:${source}:response:search:`);
      old.state = 'running';
      old.retryAt = null;
      old.errors = [];
      old.reusedRequests = 0;
      this.save(old);
      return old;
    }
    if (old) {
      const recent = this.store.getState<ImportRun[]>(`import:${source}:recent`) ?? [];
      this.store.setState(`import:${source}:recent`, [old, ...recent].slice(0, 20));
      this.store.deleteStatePrefix(`import:${source}:response:`);
    }
    // Legacy timestamps do not prove that the historical inventory was completed.
    const history = this.store.getState<boolean>(`import:${source}:history`) === true;
    const checkpoint = this.store.getCheckpoint(source);
    const since =
      !full && history && checkpoint
        ? new Date(Math.max(Date.parse(HISTORY_START), Date.parse(checkpoint) - 86400000)).toISOString()
        : null;
    const now = new Date().toISOString();
    const run: ImportRun = {
      id: randomUUID(),
      source,
      mode: since ? 'delta' : 'history',
      since,
      until: now,
      startedAt: now,
      finishedAt: null,
      state: 'running',
      phase: 'Preparando inventário',
      steps: [],
      requests: 0,
      reusedRequests: 0,
      retryAt: null,
      errors: [],
    };
    this.save(run);
    return run;
  }
  context(
    run: ImportRun,
    current: () => boolean,
    signal: AbortSignal,
    notify: (message: string) => void,
  ): Pick<IntegrationContext, 'completedSteps' | 'onStep' | 'onWait' | 'request' | 'cacheFile'> {
    const guard = () => {
      signal.throwIfAborted();
      if (!current()) throw new Error('Configuração alterada');
    };
    return {
      completedSteps: run.steps.filter((step) => step.state === 'complete').map((step) => ({ ...step })),
      onStep: (step) => {
        guard();
        const index = run.steps.findIndex((s) => s.id === step.id);
        if (index < 0) run.steps.push(step);
        else run.steps[index] = step;
        run.phase = `${step.label}: ${step.processed}${step.total === null ? ' / total a descobrir' : ` / ${step.total}`}${step.detail ? ` · ${step.detail}` : ''}`;
        this.save(run);
        notify(run.phase);
      },
      onWait: (until) => {
        guard();
        run.state = until ? 'waiting' : 'running';
        run.retryAt = until ? new Date(until).toISOString() : null;
        this.save(run);
      },
      request: async <T>(key: string, fetch: () => Promise<T>): Promise<T> => {
        guard();
        const cacheKey = `import:${run.source}:response:${key.startsWith('search/') ? 'search:' : ''}${hash(key)}`;
        const cached = this.store.getState<{ value: T }>(cacheKey);
        if (cached) {
          run.reusedRequests++;
          return cached.value;
        }
        const value = await fetch();
        guard();
        if (value && typeof value === 'object' && 'incomplete_results' in value && value.incomplete_results)
          throw new Error('A busca retornou resultados incompletos. A etapa será repetida.');
        this.store.setState(cacheKey, { value });
        run.requests++;
        this.save(run);
        return value;
      },
      cacheFile: async <T>(path: string, stamp: string, read: () => Promise<T>): Promise<T> => {
        guard();
        const key = `import:${run.source}:file:${hash(path)}`;
        const cached = this.store.getState<{ stamp: string; value: T }>(key);
        if (cached?.stamp === stamp) {
          run.reusedRequests++;
          return cached.value;
        }
        const value = await read();
        guard();
        this.store.setState(key, { stamp, value });
        run.requests++;
        this.save(run);
        return value;
      },
    };
  }
  finish(run: ImportRun, complete: boolean, errors: string[], paused: boolean): void {
    run.state = paused ? 'paused' : complete ? 'complete' : 'failed';
    run.finishedAt = new Date().toISOString();
    run.retryAt = null;
    run.errors = errors;
    if (!complete || paused) {
      for (const step of run.steps) if (step.state === 'running') step.state = run.state;
      run.phase = paused
        ? 'Pausado. Resultados já gravados serão reaproveitados.'
        : 'Pendente. A próxima tentativa reaproveita as consultas concluídas.';
    } else {
      this.store.setCheckpoint(run.source, run.until);
      this.store.setState(`import:${run.source}:success`, run.finishedAt);
      if (run.mode === 'history') this.store.setState(`import:${run.source}:history`, true);
      run.phase = 'Conferência concluída para o período consultado';
    }
    this.save(run);
  }
  history(): ImportHistory {
    const config = this.store.getConfig();
    const contributions = this.store.getContributions();
    const tokens = this.store.getTokens();
    const status = this.store.getStatus();
    return {
      syncMinutes: config.syncMinutes,
      paused: status.paused,
      running: status.running,
      generatedAt: new Date().toISOString(),
      sources: sources.map((source) => {
        const records =
          source === 'codex' || source === 'claude'
            ? tokens.filter((t) => (t.provider ?? 'codex') === source && !t.isTheSitch)
            : contributions.filter((c) => c.source === source);
        const dates = records
          .map((r) => r.occurredAt)
          .filter(Boolean)
          .sort();
        const kinds: Record<string, number> = {};
        for (const r of records) {
          const kind = 'kind' in r ? r.kind : 'tokens';
          kinds[kind] = (kinds[kind] ?? 0) + 1;
        }
        return {
          source,
          enabled:
            source === 'github'
              ? config.organizations.length > 0
              : source === 'gitlab'
                ? !!config.gitlab?.enabled
                : source === 'bitbucket'
                  ? !!config.bitbucket?.enabled
                  : source === 'azure'
                    ? config.azure.enabled
                    : true,
          lastSuccessAt: this.store.getState<string>(`import:${source}:success`),
          checkedThrough: this.store.getCheckpoint(source),
          historyComplete: this.store.getState<boolean>(`import:${source}:history`) === true,
          run: this.current(source),
          recent: this.store.getState<ImportRun[]>(`import:${source}:recent`) ?? [],
          stored: { records: records.length, first: dates[0] ?? null, last: dates.at(-1) ?? null, kinds },
        };
      }),
    };
  }
}
