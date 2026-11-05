import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDemoData } from '../backend/demo';
import { ImportJournal } from '../backend/import-history';
import { MayorLeague } from '../backend/mayor-ranking';
import { buildDashboard, dateInTimezone } from '../backend/metrics';
import { Store } from '../backend/store';
import {
  analyzeWithLuna,
  collectAzure,
  collectClaude,
  collectCodex,
  collectGithub,
  diagnose,
  discoverGithub,
  fetchNationalHolidays,
} from '../integrations';
import { collectBitbucket, collectGitlab, diagnoseForges } from '../integrations/forges';
import { inPeriod } from '../shared/contributions';
import { defaultConfig } from '../shared/defaults';
import type { AppConfig, Assessment, Dashboard, Source, SyncStatus } from '../shared/types';
import { validateConfig, validatePeriod } from '../shared/validation';
import { operationLog } from './log';

/** Coordinates durable imports and projections without exposing a shell to the UI. */
export class AppService {
  readonly store: Store;
  private league: MayorLeague;
  private leagueTimer: ReturnType<typeof setInterval> | undefined;
  private demo = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing = false;
  private analysis = new Map<string, Promise<Assessment>>();
  private journal: ImportJournal;
  private lastProgressNotification = 0;
  private configRevision = 0;
  private syncAbort: AbortController | undefined;

  constructor(
    private dataDir: string,
    home: string,
    private notify: (status: SyncStatus) => void,
  ) {
    mkdirSync(dataDir, { recursive: true });
    const config = defaultConfig(home);
    this.store = new Store(join(dataDir, 'thesitch.sqlite'), config);
    this.league = new MayorLeague(this.store);
    this.league.view({
      start: new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
      end: new Date().toISOString().slice(0, 10),
      rolling: true,
    });
    this.journal = new ImportJournal(this.store);
    this.journal.recover();
    const status = this.store.getStatus();
    const legacy = !this.store.getState<boolean>('import:initialized');
    this.store.setState('import:initialized', true);
    this.store.setStatus({
      ...status,
      ...(legacy ? { lastSync: null, coverageComplete: false } : {}),
      running: false,
      phase: 'Consulte o histórico de importações',
    });
    this.demo = process.env.THESITCH_DEMO === '1';
    this.schedule();
  }

  getMayorRanking(value: unknown) {
    const period = validatePeriod(value);
    const snapshot = this.league.view(period);
    void this.league
      .tick(this.syncing || this.demo || this.store.getStatus().paused)
      .catch(() => operationLog(this.dataDir, 'league.failed'));
    return snapshot;
  }
  refreshMayorRanking(value: unknown) {
    const period = validatePeriod(value);
    if (this.demo) throw new Error('Saia da demonstração para atualizar o ranking real.');
    if (this.store.getStatus().paused) throw new Error('Retome as importações antes de atualizar o ranking.');
    if (this.syncing)
      throw new Error('Sua importação está em andamento. Atualize o ranking quando ela terminar.');
    this.league.view(period);
    void this.league.tick(false, true).catch(() => operationLog(this.dataDir, 'league.failed'));
    return this.league.view(period);
  }
  setRankingInterval(value: unknown): void {
    if (typeof value !== 'number') throw new Error('Intervalo inválido');
    this.league.interval(value);
  }
  getImportHistory() {
    return this.journal.history();
  }
  startSync(fullHistory = false): SyncStatus {
    void this.sync(fullHistory).catch(() => operationLog(this.dataDir, 'sync.failed'));
    return this.store.getStatus();
  }
  getConfig(): AppConfig {
    return this.store.getConfig();
  }
  saveConfig(value: unknown): AppConfig {
    const previous = this.getConfig();
    const next = validateConfig(value);
    next.claudeSessionsPath ??= previous.claudeSessionsPath;
    next.gitlab ??= previous.gitlab;
    next.bitbucket ??= previous.bitbucket;
    if (
      previous.workspace.id === next.workspace.id &&
      ((previous.gitlab?.username && next.gitlab?.username !== previous.gitlab.username) ||
        (previous.bitbucket?.accountId && next.bitbucket?.accountId !== previous.bitbucket.accountId))
    )
      throw new Error(
        'Ao trocar a conta GitLab ou Bitbucket, use outro identificador do workspace para separar os históricos.',
      );
    // A new identity must not inherit another person's imports in the same installation.
    if (
      previous.workspace.id === next.workspace.id &&
      previous.workspace.members[0]?.externalLogin &&
      previous.workspace.members[0].externalLogin.toLowerCase() !==
        next.workspace.members[0]?.externalLogin.toLowerCase()
    ) {
      throw new Error(
        'Ao trocar de conta, altere também o identificador do workspace para manter os históricos separados.',
      );
    }
    this.store.saveConfig(next);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.configRevision++;
      this.syncAbort?.abort();
      this.league.cancel();
      if (this.syncing)
        this.emit({
          ...this.store.getStatus(),
          phase: 'Configurações salvas; aplicando à sincronização…',
        });
    }
    this.schedule();
    operationLog(this.dataDir, 'config.saved');
    return next;
  }

  setDemo(enabled: boolean): void {
    this.demo = enabled;
    if (enabled) this.league.cancel();
    this.emit(this.store.getStatus());
  }
  setPaused(paused: boolean): SyncStatus {
    const status = { ...this.store.getStatus(), paused };
    this.store.setStatus(status);
    if (paused) {
      this.syncAbort?.abort();
      this.league.cancel();
    }
    this.notify(status);
    if (!paused) this.startSync();
    return this.store.getStatus();
  }
  private emit(status: SyncStatus): void {
    const next = this.syncing ? { ...status, paused: this.store.getStatus().paused } : status;
    this.store.setStatus(next);
    this.notify(next);
  }
  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.leagueTimer) clearInterval(this.leagueTimer);
    this.leagueTimer = setInterval(() => {
      void this.league
        .tick(this.syncing || this.demo || this.store.getStatus().paused)
        .catch(() => operationLog(this.dataDir, 'league.failed'));
    }, 60_000);
    this.leagueTimer.unref();
    this.timer = setInterval(() => {
      void this.sync().catch(() => operationLog(this.dataDir, 'sync.failed'));
    }, this.getConfig().syncMinutes * 60_000);
    this.timer.unref();
  }
  getDashboard(value: unknown): Dashboard {
    const period = validatePeriod(value);
    const config = this.getConfig();
    let status = this.store.getStatus();
    if (this.demo) {
      const data = createDemoData(config);
      status = { ...status, errors: [], coverageComplete: true, coverageStart: data.coverageStart };
      return buildDashboard(config, data.repositories, data.contributions, data.tokens, status, period, true);
    }
    const dashboard = buildDashboard(
      config,
      this.store.getRepositories(),
      this.store.getContributions(),
      this.store.getTokens(),
      status,
      period,
      false,
    );
    const cached = this.store.getAnalysis(this.analysisKey(dashboard));
    if (cached && config.analysis.enabled) dashboard.assessment = cached;
    return dashboard;
  }
  async diagnostics() {
    const config = this.getConfig();
    const [existing, forges] = await Promise.all([diagnose(config), diagnoseForges(config)]);
    return [...existing, ...forges];
  }
  discover() {
    return discoverGithub(this.getConfig());
  }

  async sync(fullHistory = false): Promise<SyncStatus> {
    let status = this.store.getStatus();
    const config = this.getConfig();
    if (this.syncing || status.paused || this.demo || !config.onboardingComplete) return status;
    const revision = this.configRevision;
    const current = () => revision === this.configRevision;
    const abort = new AbortController();
    this.syncAbort = abort;
    this.league.cancel();
    this.syncing = true;
    const started = new Date().toISOString();
    status = { ...status, running: true, errors: [], phase: 'Abrindo os registros da cidade…' };
    operationLog(this.dataDir, 'sync.started');
    const reconciliation = fullHistory;
    try {
      this.emit(status);
      if (config.calendar.automaticHolidays) {
        const years = new Set([new Date().getFullYear(), new Date().getFullYear() - 1]);
        if (status.coverageStart) years.add(Number(status.coverageStart.slice(0, 4)));
        for (const year of years) {
          if (!current()) break;
          const checkpoint = this.store.getCheckpoint(`holidays:${year}`);
          if (checkpoint && Date.now() - Date.parse(checkpoint) < 30 * 86_400_000) continue;
          try {
            const holidays = await fetchNationalHolidays(year);
            if (!current()) break;
            config.calendar.automaticHolidayDates = {
              ...config.calendar.automaticHolidayDates,
              ...holidays,
            };
            this.store.saveConfig(config);
            this.store.setCheckpoint(`holidays:${year}`, started);
          } catch {
            if (!current()) break;
            status.errors.push({
              source: 'calendar',
              message: `Não foi possível atualizar os feriados de ${year}; calendário local mantido.`,
              at: started,
            });
          }
        }
      }
      const sources = [
        { source: 'codex', collect: collectCodex, enabled: true },
        { source: 'claude', collect: collectClaude, enabled: true },
        { source: 'github', collect: collectGithub, enabled: config.organizations.length > 0 },
        { source: 'gitlab', collect: collectGitlab, enabled: !!config.gitlab?.enabled },
        { source: 'bitbucket', collect: collectBitbucket, enabled: !!config.bitbucket?.enabled },
        { source: 'azure', collect: collectAzure, enabled: config.azure.enabled },
      ];
      for (const item of sources) {
        if (!current()) break;
        if (!item.enabled || this.store.getStatus().paused) continue;
        const run = this.journal.begin(item.source as Source, reconciliation);
        try {
          operationLog(this.dataDir, 'collect.started', { source: item.source });
          const since = run.since;
          const progress = (phase: string) => {
            if (!current()) return;
            run.phase = phase;
            this.journal.save(run);
            status = { ...status, phase };
            this.store.setStatus({ ...status, paused: this.store.getStatus().paused });
            if (Date.now() - this.lastProgressNotification > 750) {
              this.lastProgressNotification = Date.now();
              this.notify(this.store.getStatus());
            }
          };
          const result = await item.collect({
            config,
            since,
            until: run.until,
            ...this.journal.context(run, current, abort.signal, progress),
            repositories: this.store.getRepositories(),
            signal: abort.signal,
            onBatch: (batch) => {
              if (!current()) return;
              this.store.importResult(batch);
            },
            onProgress: progress,
          });
          // A save can change the account or source while a CLI request is still in flight.
          if (!current()) break;
          this.store.importResult(result);
          operationLog(this.dataDir, 'collect.finished', {
            source: item.source,
            outcome: result.complete ? 'complete' : 'partial',
          });
          status.errors.push(...result.errors);
          const paused = this.store.getStatus().paused;
          const complete = result.complete && !paused && !abort.signal.aborted;
          if (!complete && !paused && !result.errors.length)
            status.errors.push({
              source: item.source,
              message: 'Coleta incompleta. Retomada pendente.',
              at: new Date().toISOString(),
            });
          this.journal.finish(
            run,
            complete,
            result.errors.map((error) => error.message),
            paused,
          );
          if (item.source === 'github') {
            status.coverageComplete =
              complete && this.store.getState<boolean>('import:github:history') === true;
            if (complete && run.mode === 'history') {
              const dates = this.store
                .getContributions()
                .filter((c) => c.source === 'github')
                .map((c) => c.occurredAt)
                .sort();
              status.coverageStart = dates[0] ?? run.until;
            }
            if (
              result.coverageStart &&
              (!status.coverageStart || result.coverageStart < status.coverageStart)
            )
              status.coverageStart = result.coverageStart;
          }
        } catch {
          if (!current()) break;
          this.journal.finish(
            run,
            false,
            [
              abort.signal.aborted
                ? 'Interrompido pelo usuário'
                : 'Falha na coleta. A próxima tentativa reutiliza os resultados já consultados.',
            ],
            this.store.getStatus().paused,
          );
          operationLog(this.dataDir, 'collect.failed', { source: item.source });
          if (!this.store.getStatus().paused)
            status.errors.push({
              source: item.source,
              message: 'Falha na coleta. Confira a conexão e o diagnóstico da integração.',
              at: new Date().toISOString(),
            });
          if (item.source === 'github') status.coverageComplete = false;
        }
      }
      if (current()) {
        const codeSources = sources.filter(
          (item) => item.enabled && ['github', 'gitlab', 'bitbucket'].includes(item.source),
        );
        status.coverageComplete =
          codeSources.length > 0 &&
          codeSources.every(
            (item) =>
              this.store.getState<boolean>(`import:${item.source}:history`) === true &&
              this.journal.current(item.source as Source)?.state === 'complete',
          );
        const dates = this.store
          .getContributions()
          .filter((item) => ['github', 'gitlab', 'bitbucket'].includes(item.source))
          .map((item) => item.occurredAt)
          .sort();
        status.coverageStart = dates[0] ?? null;
        status = {
          ...status,
          running: false,
          lastSync:
            !status.errors.length && !this.store.getStatus().paused
              ? new Date().toISOString()
              : status.lastSync,
          phase: this.store.getStatus().paused
            ? 'Importação pausada; progresso preservado'
            : status.errors.length
              ? 'Importação com pendências; consulte o histórico'
              : codeSources.length
                ? 'Consulta concluída; confira a cobertura por fonte no histórico'
                : 'Tokens locais atualizados · nenhuma plataforma de código configurada',
        };
        this.emit(status);
        operationLog(this.dataDir, 'sync.finished', {
          outcome: status.errors.length ? 'partial' : 'complete',
        });
      }
    } finally {
      this.syncing = false;
      if (this.syncAbort === abort) this.syncAbort = undefined;
      if (!current()) {
        this.emit({
          ...this.store.getStatus(),
          running: false,
          errors: [],
          phase: 'Configurações salvas; retomando a sincronização…',
        });
        operationLog(this.dataDir, 'sync.reconfigured');
        void this.sync(fullHistory).catch(() => operationLog(this.dataDir, 'sync.failed'));
      } else if (this.store.getStatus().running) {
        status = { ...status, running: false, phase: 'Sincronização interrompida' };
        this.emit(status);
      }
    }
    if (current() && abort.signal.aborted && !this.store.getStatus().paused) this.startSync(fullHistory);
    if (!current()) return this.store.getStatus();
    if (
      config.analysis.enabled &&
      !this.store.getStatus().paused &&
      !status.errors.some((e) => ['github', 'gitlab', 'bitbucket'].includes(e.source))
    ) {
      const today = dateInTimezone(new Date(), config.calendar.timezone);
      const yesterday = new Date(`${today}T12:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const date = yesterday.toISOString().slice(0, 10);
      void (async () => {
        for (const day of [date, today]) {
          if (this.analysis.size || this.store.getStatus().paused) continue;
          try {
            await this.analyze({ start: day, end: day });
          } catch {
            operationLog(this.dataDir, 'analysis.failed');
          }
        }
      })();
    }
    return this.store.getStatus();
  }

  private periodContributions(dashboard: Dashboard) {
    return dashboard.contributions.filter((item) =>
      inPeriod(item, dashboard.period, this.getConfig().calendar.timezone),
    );
  }

  private analysisKey(dashboard: Dashboard): string {
    // Analysis must not trigger itself again by incrementing its own resource meter.
    const { analysisTokens: _analysis, ...metrics } = dashboard.metrics;
    const { analysisTokens: _previousAnalysis, ...previousMetrics } = dashboard.previousMetrics;
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          model: this.getConfig().analysis.model,
          period: dashboard.period,
          metrics,
          contributions: this.periodContributions(dashboard),
          previousMetrics,
          includeDiffs: this.getConfig().analysis.includeDiffs,
          config: this.getConfig().calendar,
        }),
      )
      .digest('hex');
  }

  async analyze(value: unknown): Promise<Assessment> {
    const period = validatePeriod(value);
    const dashboard = this.getDashboard(period);
    const contributions = this.periodContributions(dashboard);
    if (this.demo || !this.getConfig().analysis.enabled || !contributions.length) return dashboard.assessment;
    const key = this.analysisKey(dashboard);
    const cached = this.store.getAnalysis(key);
    if (cached) return cached;
    const pending = this.analysis.get(key);
    if (pending) return pending;
    if (this.analysis.size)
      throw new Error('A redação já está preparando outra edição. Aguarde um instante.');
    operationLog(this.dataDir, 'analysis.started');
    const config = this.getConfig();
    const revision = this.configRevision;
    const usageId = `analysis:${randomUUID()}`;
    const task = analyzeWithLuna(config, { ...dashboard, contributions })
      .then((assessment) => {
        // The interpretation cannot change the deterministic verdict or calendar rules.
        const verified = {
          ...assessment,
          rhythm: dashboard.assessment.rhythm,
          provisional: dashboard.assessment.provisional,
          source: 'luna' as const,
        };
        if (assessment.usage)
          this.store.importResult(
            {
              repositories: [],
              contributions: [],
              errors: [],
              complete: true,
              coverageStart: null,
              tokens: [
                {
                  id: usageId,
                  workspaceId: config.workspace.id,
                  memberId: config.workspace.members[0].id,
                  sessionId: usageId,
                  repositoryId: null,
                  occurredAt: new Date().toISOString(),
                  ...assessment.usage,
                  model: config.analysis.model,
                  isTheSitch: true,
                  provider: 'codex',
                },
              ],
            },
            config.workspace.id,
          );
        if (revision !== this.configRevision) {
          operationLog(this.dataDir, 'analysis.discarded', { outcome: 'configuration_changed' });
          this.notify(this.store.getStatus());
          return this.getDashboard(period).assessment;
        }
        this.store.setAnalysis(key, verified);
        operationLog(this.dataDir, 'analysis.finished');
        this.notify(this.store.getStatus());
        return verified;
      })
      .finally(() => this.analysis.delete(key));
    this.analysis.set(key, task);
    return task;
  }
  groupContributions(ids: string[], groupId: string | null): void {
    this.store.groupContributions(ids, groupId);
  }
  close(): void {
    this.league.close();
    if (this.leagueTimer) clearInterval(this.leagueTimer);
    this.syncAbort?.abort();
    if (this.timer) clearInterval(this.timer);
    this.store.close();
  }
}
