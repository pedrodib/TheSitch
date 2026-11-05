import type React from 'react';
import { cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { version as appVersion } from '../../package.json';
import { inPeriod, localDate } from '../shared/contributions';
import type {
  AppConfig,
  Assessment,
  Contribution,
  Dashboard,
  Diagnostic,
  ImportHistory,
  Period,
  SyncStatus,
  TheSitchApi,
} from '../shared/types';
import brandIcon from './assets/thesitch-mark.png';
import { CustomPeriod } from './custom-period';
import { CyberCity } from './cyber-city';
import { ForgeSettings } from './forge-settings';
import { ImportHistoryScreen, ImportSummary } from './import-history';
import { MayorRankingPanel } from './mayor-ranking';
import './import-history.css';
import { MayorMeter } from './mayor-meter';
import './style.css';
import './game.css';
import './cyberpunk.css';

declare global {
  interface Window {
    theSitch: TheSitchApi;
  }
}
const api = window.theSitch;
const fmt = new Intl.NumberFormat('pt-BR');
const compactFmt = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const short = (n: number) => compactFmt.format(n);
function makePeriod(kind: string, timezone = 'America/Sao_Paulo'): Period {
  const end = localDate(new Date(), timezone);
  const start = new Date(`${end}T12:00:00Z`);
  if (kind === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  else if (kind === 'rolling') start.setUTCDate(start.getUTCDate() - 29);
  return { start: start.toISOString().slice(0, 10), end, ...(kind === 'rolling' ? { rolling: true } : {}) };
}
const dateLabel = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const stateLabel: Record<string, string> = {
  building: 'Em construção',
  inspection: 'Em revisão',
  merged: 'Concluída',
  deployed: 'Entregue',
  closed: 'Encerrada sem entrega',
};
const kindLabel: Record<string, string> = {
  pull_request: 'Pull request',
  review: 'Revisão',
  commit: 'Commit',
  work_item: 'Item de trabalho',
};
const niceError = (e: unknown) => (e instanceof Error ? e.message : String(e));
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3.8a7 7 0 0 0-1.7-1L14.5 3h-4L10 5.9a7 7 0 0 0-1.7 1L6 6.1 4 9.5 6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-.8a7 7 0 0 0 1.7 1l.5 2.9h4l.5-2.9a7 7 0 0 0 1.7-1l2.3.8 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5 9a7 7 0 0 1 12-3l3 3M4 15l3 3a7 7 0 0 0 12-3" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    close: <path d="M5 5l14 14M19 5 5 19" />,
    external: (
      <>
        <path d="M13 5h6v6M19 5l-9 9" />
        <path d="M19 14v5H5V5h5" />
      </>
    ),
    pause: <path d="M9 5v14M15 5v14" />,
    play: <path d="m8 5 11 7-11 7z" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    spark: (
      <path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Zm6 13 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z" />
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactElement<{ id?: string }>;
  hint?: string;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      {cloneElement(children, { id })}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}
function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [periodKind, setPeriodKind] = useState('rolling');
  const [period, setPeriod] = useState<Period>(() => makePeriod('rolling'));
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedContribution, setSelectedContribution] = useState<Contribution | null>(null);
  const [page, setPage] = useState(0);
  const [panel, setPanel] = useState('city');
  const [imports, setImports] = useState<ImportHistory | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(100);
  const [replay, setReplay] = useState(100);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [visibleCount, setVisibleCount] = useState(15);
  const sortedRepos = useMemo(
    () => [...(dashboard?.repositories ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    [dashboard?.repositories],
  );
  const cityRepos = useMemo(() => sortedRepos.slice(page * 8, page * 8 + 8), [sortedRepos, page]);
  const activeLoad = useRef<{ key: string; promise: Promise<[Dashboard, ImportHistory]> } | null>(null);
  const load = useCallback(async () => {
    const key = JSON.stringify(period);
    const request =
      activeLoad.current?.key === key
        ? activeLoad.current
        : { key, promise: Promise.all([api.getDashboard(period), api.getImportHistory()]) };
    activeLoad.current = request;
    try {
      const [data, history] = await request.promise;
      if (activeLoad.current !== request) return;
      setImports(history);
      setDashboard(data);
      setStatus(data.status);
    } catch (e) {
      if (activeLoad.current === request) setError(niceError(e));
    } finally {
      if (activeLoad.current === request) activeLoad.current = null;
    }
  }, [period]);
  useEffect(() => {
    api
      .getConfig()
      .then((next) => {
        setConfig(next);
        setPeriod(makePeriod('rolling', next.calendar.timezone));
      })
      .catch((e) => setError(niceError(e)));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer = undefined;
      if (!document.hidden) void load();
    };
    const unsubscribe = api.onStatus((s) => {
      setStatus(s);
      if (!s.running) {
        clearTimeout(timer);
        refresh();
      } else if (!timer && !document.hidden) timer = setTimeout(refresh, 5000);
    });
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        refresh();
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);
  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(niceError(e));
    } finally {
      setBusy('');
    }
  }
  const choosePeriod = (kind: string) => {
    setPeriodKind(kind);
    setReplay(100);
    setVisibleCount(15);
    if (kind !== 'custom') setPeriod(makePeriod(kind, config?.calendar.timezone));
    else setPeriod((value) => ({ start: value.start, end: value.end }));
  };
  const selectRepo = useCallback(
    (id: string) => {
      const index = sortedRepos.findIndex((repo) => repo.id === id);
      if (index >= 0) setPage(Math.floor(index / 8));
      setPanel('districts');
      setSelected(id);
      setSelectedContribution(null);
      setVisibleCount(15);
    },
    [sortedRepos],
  );
  const repo = dashboard?.repositories.find((r) => r.id === selected);
  const items = useMemo(
    () =>
      dashboard?.contributions
        .filter(
          (c) =>
            (!selected || c.repositoryId === selected) &&
            inPeriod(c, period, config?.calendar.timezone ?? 'America/Sao_Paulo'),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [],
    [dashboard, selected, period, config?.calendar.timezone],
  );
  const startDemo = () =>
    action('demo', async () => {
      await api.setDemo(true);
      await load();
    });
  const save = () =>
    action('save', async () => {
      if (!config) return;
      const next = await api.saveConfig({
        ...config,
        organizations: config.organizations.map((v) => v.trim()).filter(Boolean),
        gitlab: config.gitlab
          ? {
              ...config.gitlab,
              host: config.gitlab.host.trim(),
              username: config.gitlab.username.trim(),
              projects: config.gitlab.projects.map((s) => s.trim()).filter(Boolean),
              commitEmails: config.gitlab.commitEmails?.map((s) => s.trim()).filter(Boolean),
            }
          : undefined,
        bitbucket: config.bitbucket
          ? {
              ...config.bitbucket,
              email: config.bitbucket.email.trim(),
              accountId: config.bitbucket.accountId.trim(),
              tokenFile: config.bitbucket.tokenFile.trim(),
              repositories: config.bitbucket.repositories.map((s) => s.trim()).filter(Boolean),
            }
          : undefined,
        azure: { ...config.azure, projects: config.azure.projects.map((v) => v.trim()).filter(Boolean) },
        calendar: {
          ...config.calendar,
          excludedDates: config.calendar.excludedDates.map((v) => v.trim()).filter(Boolean),
        },
        onboardingComplete: true,
      });
      setConfig(next);
      setSettings(false);
      await load();
    });
  const discover = () =>
    action('discover', async () => {
      const checks = await api.diagnostics();
      setDiagnostics(checks);
      const found = await api.discover();
      setDiscovered(found.organizations);
      setConfig((c) =>
        c
          ? {
              ...c,
              organizations: found.organizations,
              workspace: {
                ...c.workspace,
                members: c.workspace.members.map((m, i) =>
                  i === 0 ? { ...m, externalLogin: found.login } : m,
                ),
              },
            }
          : c,
      );
    });
  if (!config)
    return (
      <div className="splash">
        <img className="brand-mark brand-icon" src={brandIcon} alt="" width="44" height="44" />
        <h1>The Sitch</h1>
        <p>{error || 'Preparando a cidade…'}</p>
      </div>
    );
  const needsGithubSetup =
    !config.organizations.some((org) => org.trim()) || !config.workspace.members[0]?.externalLogin.trim();
  const otherForgeConfigured = !!config.gitlab?.enabled || !!config.bitbucket?.enabled;
  const onboarding =
    (!config.onboardingComplete || (needsGithubSetup && !otherForgeConfigured)) && !dashboard?.demo;
  return (
    <div className={`app game-view cyberpunk panel-${panel} ${config.reducedMotion ? 'reduce-motion' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark brand-icon" src={brandIcon} alt="" width="44" height="44" />
          <span>
            The Sitch<small>UMA CIDADE DO SEU TRABALHO</small>
          </span>
        </div>
        <div className="top-right">
          <span className="edition">NEON CITY · v{appVersion}</span>
          {dashboard?.demo && <span className="demo-badge">MODO DEMO</span>}
          {!dashboard?.demo && (
            <button
              type="button"
              className="outline-button"
              disabled={!!busy || status?.running || status?.paused}
              onClick={() =>
                needsGithubSetup
                  ? setSettings(true)
                  : action('import-history', async () => {
                      setStatus(await api.sync(true));
                      await load();
                    })
              }
            >
              {busy === 'import-history' ? 'Importando…' : 'Importar histórico'}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Configurações"
            onClick={() => setSettings(true)}
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>
      <nav className="game-dock" aria-label="Menu da cidade">
        {[
          ['city', '⌂', 'Cidade'],
          ['districts', '▥', 'Bairros'],
          ['gazette', '♜', 'Prefeito'],
          ['energy', '✧', 'Energia'],
          ['ranking', '♛', 'Ranking'],
        ].map(([id, icon, label]) => (
          <button
            type="button"
            key={id}
            aria-label={label}
            aria-pressed={panel === id}
            onClick={() => setPanel(panel === id ? 'city' : id)}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      {panel !== 'city' && (
        <button
          type="button"
          className="close-game-panel"
          aria-label="Fechar painel"
          onClick={() => setPanel('city')}
        >
          ×
        </button>
      )}
      {panel === 'ranking' && <MayorRankingPanel period={period} demo={dashboard?.demo ?? false} />}
      <ImportSummary history={imports} onOpen={() => setHistoryOpen(true)} />
      {historyOpen && (
        <ImportHistoryScreen
          history={imports}
          error={error}
          onClose={() => setHistoryOpen(false)}
          onSync={(full) =>
            action('sync', async () => {
              setStatus(await api.sync(full));
              await load();
            })
          }
          onPause={(paused) =>
            action('pause', async () => {
              setStatus(await api.setPaused(paused));
              await load();
            })
          }
        />
      )}
      <MayorMeter dashboard={dashboard} onOpen={() => setPanel('gazette')} />
      <main>
        <div className="intro">
          <div>
            <div className="eyebrow">
              <span>◈</span> CONEXÃO COM A CIDADE ATIVA <span>◈</span>
            </div>
            <h1>
              Seu trabalho, <em>uma cidade.</em>
            </h1>
            <p>Uma nova perspectiva sobre tudo o que você está construindo.</p>
          </div>
          <div className="date-stamp">
            <Icon name="sun" size={25} />
            <span>
              DIÁRIO DE BORDO<strong>{dateLabel(period.end)}</strong>
            </span>
          </div>
        </div>
        {error && !settings && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Fechar aviso">
              ×
            </button>
          </div>
        )}
        {onboarding && (
          <section className="onboarding paper">
            <div>
              <span className="kicker">PRIMEIRA VISITA</span>
              <h2>Vamos conectar sua cidade?</h2>
              <p>
                Configure GitHub, GitLab ou Bitbucket nas fontes para importar suas contribuições desde o
                início. Salvar apenas suas preferências ainda não importa esse histórico.
              </p>
              <div className="button-row">
                <button type="button" className="primary" disabled={!!busy} onClick={discover}>
                  {busy === 'discover' ? 'Procurando…' : 'Verificar ferramentas e descobrir organizações'}{' '}
                  <Icon name="arrow" size={16} />
                </button>
                <button type="button" className="text-button" onClick={() => setSettings(true)}>
                  Configurar manualmente
                </button>
                <button type="button" className="text-button" disabled={!!busy} onClick={startDemo}>
                  Explorar demonstração
                </button>
              </div>
              {diagnostics.length > 0 && (
                <div className="diagnostics">
                  {diagnostics.map((d) => (
                    <div key={d.source}>
                      <b className={d.authenticated ? 'good' : ''}>
                        {d.authenticated ? '●' : '○'} {d.source.toUpperCase()}
                      </b>
                      <span>{d.message || d.version}</span>
                    </div>
                  ))}
                  {discovered.length > 0 && <p>Organizações encontradas: {discovered.join(', ')}</p>}
                  <button type="button" className="text-button" onClick={() => setSettings(true)}>
                    Revisar configuração <Icon name="arrow" size={14} />
                  </button>
                </div>
              )}
            </div>
            <div className="onboarding-seal">
              ✳
              <small>
                LA VITA
                <br />È BELLA
              </small>
            </div>
          </section>
        )}
        <div className="controls">
          <div className="period-label">
            PERÍODO <span>—</span>
          </div>
          <div className="segmented">
            {[
              ['day', 'Hoje'],
              ['week', 'Esta semana'],
              ['rolling', 'Últimos 30 dias'],
              ['custom', 'Personalizado'],
            ].map(([v, l]) => (
              <button
                type="button"
                key={v}
                className={periodKind === v ? 'active' : ''}
                onClick={() => choosePeriod(v)}
              >
                {l}
              </button>
            ))}
          </div>
          {periodKind === 'custom' && (
            <CustomPeriod
              value={period}
              onChange={(next) => {
                setReplay(100);
                setPeriod(next);
              }}
            />
          )}
          <div className="period-dates">
            {dateLabel(period.start)} <span>—</span> {dateLabel(period.end)}
          </div>
        </div>
        <div className="overview">
          <div className="map-card paper">
            <div className="card-heading">
              <div>
                <span className="kicker">A CIDADE EM MOVIMENTO</span>
                <h2>
                  Neon City <span>✳</span>
                </h2>
                <p>Cada bairro é um repositório. Cada construção, uma história.</p>
              </div>
              <div className="map-key">
                <span>
                  <i /> ATIVIDADE NO PERÍODO
                </span>
                <strong>{dashboard?.repositories.length ?? 0} bairros</strong>
              </div>
            </div>
            <div className="map-frame">
              <CyberCity
                repos={cityRepos}
                contributions={dashboard?.contributions ?? []}
                selected={selected}
                onSelect={selectRepo}
                zoom={zoom}
                onZoom={setZoom}
                reducedMotion={config.reducedMotion}
                replay={replay}
                period={period}
                timezone={config.calendar.timezone}
                energy={dashboard?.metrics.tokens ?? 0}
              />
              <div className="map-tools">
                <select
                  aria-label="Ir para bairro"
                  value={selected ?? ''}
                  onChange={(e) => selectRepo(e.target.value)}
                >
                  <option value="" disabled>
                    Ir para bairro… ({sortedRepos.length})
                  </option>
                  {sortedRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Aumentar zoom"
                  onClick={() => setZoom((value) => Math.min(220, value + 20))}
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Diminuir zoom"
                  onClick={() => setZoom((value) => Math.max(50, value - 20))}
                >
                  −
                </button>
              </div>
              <div className="map-caption">
                NEON CITY <span>·</span> YOUR WORK, ALIVE
              </div>
              {dashboard && dashboard.repositories.length === 0 && (
                <div className="map-empty">
                  Ainda não há bairros por aqui.
                  <br />
                  <small>Sincronize suas fontes para começar a construir.</small>
                </div>
              )}
            </div>
            <div className="map-footer">
              <div>
                <span className="kicker">REPLAY DA CIDADE</span>
                <small>Acompanhe a atividade ao longo do período</small>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={replay}
                aria-label="Progresso do replay"
                onChange={(e) => setReplay(Number(e.target.value))}
              />
              <span className="replay-value">{replay}%</span>
              {(dashboard?.repositories.length ?? 0) > 8 && (
                <div className="map-pages">
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                    aria-label="Página anterior de bairros"
                  >
                    ‹
                  </button>
                  <span>
                    Bairros {page * 8 + 1}–{Math.min((page + 1) * 8, sortedRepos.length)} de{' '}
                    {sortedRepos.length}
                  </span>
                  <button
                    type="button"
                    disabled={(page + 1) * 8 >= (dashboard?.repositories.length ?? 0)}
                    onClick={() => setPage(page + 1)}
                    aria-label="Próxima página de bairros"
                  >
                    ›
                  </button>
                </div>
              )}
            </div>
          </div>
          <aside className="gazette paper">
            <div className="gazette-top">
              <span>CITY SIGNAL</span>
              <span>✳</span>
              <span>CANAL 01</span>
            </div>
            <div className="gazette-title">
              City Signal<small>AVALIAÇÃO DO PREFEITO</small>
            </div>
            <div className="gazette-rule">
              <span>TRANSMISSÃO DA CIDADE</span>
              <span>◆</span>
              <span>{dateLabel(period.end)}</span>
            </div>
            <div className="gazette-body">
              <span className="kicker">O QUE SE DIZ POR AQUI</span>
              <p className="meter-explanation">
                Prefeitômetro: 5 em alta, 4 estável, 3 atenção, 2 alerta, 1 crítico. Compara entregas por dia
                útil com seu histórico: acima de +20%, até −20%, até −40%, até −60% e abaixo de −60%. Dias não
                úteis são neutros; sem base suficiente, fica calibrando. Qualidade e impacto precisam das
                evidências abaixo.
              </p>
              <h2>{dashboard?.assessment.headline || 'A cidade aguarda suas primeiras notícias.'}</h2>
              <div className="ornament">✳ ─── ✳ ─── ✳</div>
              <p>
                {dashboard?.assessment.summary ||
                  'Quando os dados chegarem, esta gazeta trará uma leitura do seu ritmo de trabalho.'}
              </p>
              {dashboard?.assessment.caveat && <p className="caveat">{dashboard.assessment.caveat}</p>}
              {dashboard?.assessment.priority && (
                <div className="priority">
                  <strong>EM PAUTA</strong> {dashboard.assessment.priority}
                </div>
              )}
              <div className="assessment-evidence">
                {dashboard?.assessment.evidenceIds.map((id) => {
                  const evidence = dashboard.contributions.find((c) => c.id === id);
                  return evidence?.url ? (
                    <button
                      type="button"
                      className="text-button"
                      key={id}
                      onClick={() => action('open', () => api.openExternal(evidence.url))}
                    >
                      ↗ {evidence.title}
                    </button>
                  ) : null;
                })}
              </div>
              <div className="assessment-meta">
                {dashboard?.assessment && (
                  <>
                    {dashboard.assessment.source === 'luna' ? 'ANÁLISE LUNA' : 'LEITURA LOCAL'} · CONFIANÇA{' '}
                    {dashboard.assessment.confidence === 'high'
                      ? 'ALTA'
                      : dashboard.assessment.confidence === 'moderate'
                        ? 'MODERADA'
                        : 'BAIXA'}
                    {dashboard.assessment.provisional ? ' · PROVISÓRIA' : ''}
                  </>
                )}
              </div>
              <button
                type="button"
                className="outline-button"
                disabled={!config.analysis.enabled || !!busy}
                title={!config.analysis.enabled ? 'Ative a análise nas configurações' : ''}
                onClick={() =>
                  action('analyze', async () => {
                    const assessment: Assessment = await api.analyze(period);
                    setDashboard((d) => (d ? { ...d, assessment } : d));
                  })
                }
              >
                <Icon name="spark" size={16} />
                {busy === 'analyze' ? 'Consultando…' : 'Atualizar com Luna'}
              </button>
              {!config.analysis.enabled && (
                <small className="muted">Análise por IA desativada nas configurações.</small>
              )}
            </div>
            <div className="gazette-bottom">
              SINAIS, DADOS E EVIDÊNCIAS <span>✳</span> ONLINE
            </div>
          </aside>
        </div>
        <section className="metrics-section">
          <div className="section-heading">
            <div>
              <span className="kicker">A VIDA NA CIDADE</span>
              <h2>
                Um olhar sobre o período<span>.</span>
              </h2>
            </div>
            <p>
              Valores ao lado: período anterior
              {dashboard?.metrics.changePercent != null
                ? ` · Ritmo vs. histórico: ${dashboard.metrics.changePercent > 0 ? '+' : ''}${dashboard.metrics.changePercent.toFixed(1).replace('.', ',')}% por dia útil`
                : ''}
            </p>
          </div>
          <div className="metrics">
            <Metric
              icon="✳"
              label="ENTREGAS"
              value={dashboard?.metrics.deliveries}
              previous={dashboard?.previousMetrics.deliveries}
              note="histórias em movimento"
            />
            <Metric
              icon="◇"
              label="PULL REQUESTS"
              value={dashboard?.metrics.pullRequests}
              previous={dashboard?.previousMetrics.pullRequests}
              note="ideias compartilhadas"
            />
            <Metric
              icon="▦"
              label="COMMITS"
              value={dashboard?.metrics.commits}
              previous={dashboard?.previousMetrics.commits}
              note="módulos na cidade"
            />
            <Metric
              icon="✧"
              label="REVISÕES"
              value={dashboard?.metrics.reviews}
              previous={dashboard?.previousMetrics.reviews}
              note="olhares cuidadosos"
            />
            <Metric
              icon="↗"
              label="PUBLICADAS"
              value={dashboard?.metrics.deployed}
              previous={dashboard?.previousMetrics.deployed}
              note="chegaram ao destino"
            />
          </div>
        </section>
        <section className="lower-grid">
          <div className="districts paper">
            <div className="section-heading compact">
              <div>
                <span className="kicker">EXPLORE A CIDADE</span>
                <h2>
                  Bairros & histórias<span>.</span>
                </h2>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSelected(null);
                  setSelectedContribution(null);
                }}
              >
                Ver todos
              </button>
            </div>
            <p className="section-description">
              Selecione um bairro no mapa ou na lista para conhecer suas atividades.
            </p>
            <div className="district-list">
              {(dashboard?.repositories ?? []).map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className={`district-row ${selected === r.id ? 'selected' : ''}`}
                  onClick={() => selectRepo(r.id)}
                >
                  <span className="district-icon">⌂</span>
                  <span>
                    <strong>{r.name}</strong>
                    <small>{r.fullName}</small>
                  </span>
                  <span className="district-count">
                    {dashboard?.contributions.filter(
                      (c) => c.repositoryId === r.id && inPeriod(c, period, config.calendar.timezone),
                    ).length ?? 0}{' '}
                    atividades
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
              {dashboard?.repositories.length === 0 && (
                <p className="empty-text">Nenhum repositório encontrado neste período.</p>
              )}
            </div>
          </div>
          <div className="activity paper">
            <div className="section-heading compact">
              <div>
                <span className="kicker">DIÁRIO DE BORDO</span>
                <h2>
                  {repo ? repo.name : 'Últimas histórias'}
                  <span>.</span>
                </h2>
              </div>
              {repo?.url && (
                <button
                  type="button"
                  className="icon-button"
                  title="Abrir repositório"
                  onClick={() => action('open', () => api.openExternal(repo.url))}
                >
                  <Icon name="external" />
                </button>
              )}
            </div>
            {selectedContribution ? (
              <div className="detail">
                <button type="button" className="text-button" onClick={() => setSelectedContribution(null)}>
                  ← Voltar às histórias
                </button>
                <span className="tag">{stateLabel[selectedContribution.state]}</span>
                <h3>{selectedContribution.title}</h3>
                <p>{selectedContribution.body || 'Sem descrição adicional.'}</p>
                {!!selectedContribution.associatedPullRequests?.length && (
                  <p>
                    Commit vinculado ao PR{' '}
                    {selectedContribution.associatedPullRequests.map((n) => `#${n}`).join(', ')}. Aparece na
                    métrica de commits e nos módulos neon, sem contar como uma entrega adicional.
                  </p>
                )}
                <small>
                  {kindLabel[selectedContribution.kind]} · {dateLabel(selectedContribution.occurredAt)} · +
                  {selectedContribution.additions} / −{selectedContribution.deletions}
                </small>
                {selectedContribution.url && (
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => action('open', () => api.openExternal(selectedContribution.url))}
                  >
                    Abrir evidência <Icon name="external" size={15} />
                  </button>
                )}
              </div>
            ) : (
              <div className="activity-list">
                {items.slice(0, visibleCount).map((c) => (
                  <div className="activity-row" key={c.id}>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${c.title} para agrupamento`}
                      checked={groupIds.includes(c.id)}
                      onChange={(e) =>
                        setGroupIds(
                          e.target.checked ? [...groupIds, c.id] : groupIds.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <button type="button" onClick={() => setSelectedContribution(c)}>
                      <span className="activity-dot" />
                      <span>
                        <strong>{c.title}</strong>
                        <small>
                          {kindLabel[c.kind]} · {dateLabel(c.occurredAt)} · {stateLabel[c.state]}
                        </small>
                      </span>
                      <Icon name="chevron" size={15} />
                    </button>
                  </div>
                ))}
                {items.length === 0 && (
                  <p className="empty-text">
                    Nenhuma atividade encontrada. Sua próxima história começa aqui.
                  </p>
                )}
              </div>
            )}
            {items.length > visibleCount && (
              <button
                type="button"
                className="text-button"
                onClick={() => setVisibleCount(visibleCount + 25)}
              >
                Mostrar mais histórias ({items.length - visibleCount})
              </button>
            )}
            {groupIds.length > 0 && (
              <div className="group-controls">
                <input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Identificador do grupo"
                  aria-label="Identificador do grupo"
                />
                <button
                  type="button"
                  onClick={() =>
                    action('group', async () => {
                      await api.groupContributions(groupIds, groupName.trim() || null);
                      setGroupIds([]);
                      setGroupName('');
                      await load();
                    })
                  }
                >
                  {groupName.trim() ? 'Agrupar' : 'Desagrupar'} ({groupIds.length})
                </button>
              </div>
            )}
          </div>
        </section>
        <section className="energy paper">
          <div>
            <span className="kicker">A ENERGIA POR TRÁS DA CIDADE</span>
            <h2>
              Pequenas faíscas, grandes ideias<span>.</span>
            </h2>
            <p>Tokens registrados nas sessões locais do Codex e Claude Code.</p>
            <p>
              Codex: <b>{short(dashboard?.metrics.tokensByProvider?.codex ?? 0)}</b>
              {' · '}Claude Code: <b>{short(dashboard?.metrics.tokensByProvider?.claude ?? 0)}</b>
              <br />
              Inclui sessões sem repositório; avaliações do The Sitch aparecem separadamente.
            </p>
          </div>
          <div className="energy-stats">
            <div>
              <strong>{short(dashboard?.metrics.tokens ?? 0)}</strong>
              <small>TOKENS EM REPOSITÓRIOS</small>
            </div>
            <div>
              <strong>{short(dashboard?.metrics.unassignedTokens ?? 0)}</strong>
              <small>SEM REPOSITÓRIO</small>
            </div>
            <div>
              <strong>{short(dashboard?.metrics.analysisTokens ?? 0)}</strong>
              <small>THE SITCH</small>
            </div>
          </div>
        </section>
        <footer className="app-footer">
          <span>✳ &nbsp; FEITO PARA VER O TODO, COM MAIS CALMA.</span>
          <div>
            <span className={status?.errors.length ? 'status-dot warn' : 'status-dot'} />
            {status?.running
              ? status.phase || 'Sincronizando'
              : status?.paused
                ? 'Sincronização pausada'
                : status?.lastSync
                  ? `Última conclusão: ${new Date(status.lastSync).toLocaleString('pt-BR')}`
                  : 'Ainda não sincronizado'}{' '}
            <button
              type="button"
              className="icon-button"
              aria-label="Sincronizar agora"
              disabled={!!busy || status?.running}
              onClick={() =>
                action('sync', async () => {
                  setStatus(await api.sync());
                  await load();
                })
              }
            >
              <Icon name="refresh" size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={status?.paused ? 'Retomar sincronização' : 'Pausar sincronização'}
              onClick={() => action('pause', async () => setStatus(await api.setPaused(!status?.paused)))}
            >
              <Icon name={status?.paused ? 'play' : 'pause'} size={15} />
            </button>
          </div>
        </footer>
        {status?.errors.map((e) => (
          <div className="sync-error" key={`${e.source}-${e.at}-${e.message}`}>
            {e.source}: {e.message}
          </div>
        ))}
      </main>
      {settings && (
        <Settings
          config={config}
          setConfig={setConfig}
          close={() => setSettings(false)}
          save={save}
          discover={discover}
          diagnostics={diagnostics}
          busy={busy}
          error={error}
          syncing={!!status?.running}
          demo={!!dashboard?.demo}
          switchDemo={() =>
            action('demo', async () => {
              await api.setDemo(!dashboard?.demo);
              await load();
            })
          }
          importConfig={() =>
            action('import', async () => {
              const c = await api.importConfig();
              if (c) setConfig(c);
            })
          }
          exportConfig={() =>
            action('export', async () => {
              await api.exportConfig();
            })
          }
        />
      )}
    </div>
  );
}
function Metric({
  icon,
  label,
  value,
  previous,
  note,
}: {
  icon: string;
  label: string;
  value?: number;
  previous?: number;
  note: string;
}) {
  const diff = (value ?? 0) - (previous ?? 0);
  return (
    <div className="metric paper">
      <div className="metric-top">
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <strong>{value === undefined ? '—' : fmt.format(value)}</strong>
      <div>
        <span className={diff < 0 ? 'metric-change down' : 'metric-change'}>
          {diff > 0 ? '+' : ''}
          {diff}
        </span>{' '}
        <small>vs. anterior · {note}</small>
      </div>
    </div>
  );
}
function Settings({
  config,
  setConfig,
  close,
  save,
  discover,
  diagnostics,
  busy,
  error,
  syncing,
  demo,
  switchDemo,
  importConfig,
  exportConfig,
}: {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig | null>>;
  close: () => void;
  save: () => void;
  discover: () => void;
  diagnostics: Diagnostic[];
  busy: string;
  error: string;
  syncing: boolean;
  demo: boolean;
  switchDemo: () => void;
  importConfig: () => void;
  exportConfig: () => void;
}) {
  const update = (patch: Partial<AppConfig>) => setConfig((c) => (c ? { ...c, ...patch } : c));
  const [mappingText, setMappingText] = useState(() =>
    Object.entries(config.repoMappings)
      .map(([a, b]) => `${a}=${b}`)
      .join('\n'),
  );
  const [holidayText, setHolidayText] = useState(() =>
    Object.entries(config.calendar.holidays)
      .map(([a, b]) => `${a}=${b}`)
      .join('\n'),
  );
  const entries = (text: string) =>
    Object.fromEntries(
      text
        .split('\n')
        .map((line) => {
          const i = line.indexOf('=');
          return i < 0 ? ['', ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        })
        .filter(([key]) => key),
    );
  return (
    <div className="modal-backdrop">
      <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <div>
            <span className="kicker">CUIDE DA SUA CIDADE</span>
            <h2 id="settings-title">
              Configurações<span>.</span>
            </h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar configurações" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-content">
          <p>Defina suas fontes e preferências. As alterações são aplicadas ao salvar.</p>
          {syncing && (
            <p>A coleta está em andamento. Você pode salvar; ela retoma com as novas configurações.</p>
          )}
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <div className="settings-section">
            <h3>
              01 <span>Sua identidade</span>
            </h3>
            <div className="form-grid">
              <Field label="Seu nome">
                <input
                  value={config.workspace.members[0]?.name ?? ''}
                  onChange={(e) =>
                    update({
                      workspace: {
                        ...config.workspace,
                        members: config.workspace.members.map((m, i) =>
                          i === 0 ? { ...m, name: e.target.value } : m,
                        ),
                      },
                    })
                  }
                />
              </Field>
              <Field label="Login GitHub">
                <input
                  value={config.workspace.members[0]?.externalLogin ?? ''}
                  onChange={(e) =>
                    update({
                      workspace: {
                        ...config.workspace,
                        members: config.workspace.members.map((m, i) =>
                          i === 0 ? { ...m, externalLogin: e.target.value } : m,
                        ),
                      },
                    })
                  }
                />
              </Field>
              <Field
                label="Identificador do espaço"
                hint="Use um novo identificador ao trocar de identidade."
              >
                <input
                  value={config.workspace.id}
                  onChange={(e) => update({ workspace: { ...config.workspace, id: e.target.value } })}
                />
              </Field>
              <Field label="Nome da cidade">
                <input
                  value={config.workspace.name}
                  onChange={(e) => update({ workspace: { ...config.workspace, name: e.target.value } })}
                />
              </Field>
              <Field label="Host GitHub">
                <input value={config.githubHost} onChange={(e) => update({ githubHost: e.target.value })} />
              </Field>
            </div>
            <Field
              label="Organizações GitHub"
              hint="Uma por linha. Ao salvar, o app inicia a importação do histórico dessas organizações."
            >
              <textarea
                value={config.organizations.join('\n')}
                onChange={(e) => update({ organizations: e.target.value.split('\n') })}
              />
            </Field>
            <button type="button" className="outline-button" disabled={!!busy} onClick={discover}>
              <Icon name="refresh" size={15} /> Verificar CLIs e descobrir organizações
            </button>
            {diagnostics.map((d) => (
              <p className="diagnostic-line" key={d.source}>
                {d.authenticated ? '●' : '○'} {d.source}: {d.message || d.version}
              </p>
            ))}
          </div>
          <div className="settings-section">
            <h3>
              02 <span>Fontes e ferramentas</span>
            </h3>
            <div className="form-grid">
              <Field label="Caminho do GitHub CLI">
                <input
                  value={config.cli.gh}
                  onChange={(e) => update({ cli: { ...config.cli, gh: e.target.value } })}
                />
              </Field>
              <Field label="Caminho do Azure CLI">
                <input
                  value={config.cli.az}
                  onChange={(e) => update({ cli: { ...config.cli, az: e.target.value } })}
                />
              </Field>
              <Field label="Caminho do Codex CLI">
                <input
                  value={config.cli.codex}
                  onChange={(e) => update({ cli: { ...config.cli, codex: e.target.value } })}
                />
              </Field>
              <Field label="Pasta de sessões Codex">
                <input
                  value={config.codexSessionsPath}
                  onChange={(e) => update({ codexSessionsPath: e.target.value })}
                />
              </Field>
              <Field
                label="Pasta de sessões Claude Code"
                hint="Leitura local dos registros de uso, incluindo subagentes."
              >
                <input
                  value={config.claudeSessionsPath ?? ''}
                  onChange={(e) => update({ claudeSessionsPath: e.target.value })}
                />
              </Field>
            </div>
            <ForgeSettings config={config} update={update} />
            <Toggle
              label="Conectar Azure DevOps"
              checked={config.azure.enabled}
              onChange={(v) => update({ azure: { ...config.azure, enabled: v } })}
            />
            {config.azure.enabled && (
              <div className="form-grid">
                <Field label="Organização Azure">
                  <input
                    value={config.azure.organization}
                    onChange={(e) => update({ azure: { ...config.azure, organization: e.target.value } })}
                  />
                </Field>
                <Field label="Projetos Azure" hint="Separe por vírgula; vazio inclui todos.">
                  <input
                    value={config.azure.projects.join(', ')}
                    onChange={(e) =>
                      update({
                        gitlab: config.gitlab
                          ? {
                              ...config.gitlab,
                              host: config.gitlab.host.trim(),
                              username: config.gitlab.username.trim(),
                              projects: config.gitlab.projects.map((s) => s.trim()).filter(Boolean),
                              commitEmails: config.gitlab.commitEmails?.map((s) => s.trim()).filter(Boolean),
                            }
                          : undefined,
                        bitbucket: config.bitbucket
                          ? {
                              ...config.bitbucket,
                              email: config.bitbucket.email.trim(),
                              accountId: config.bitbucket.accountId.trim(),
                              tokenFile: config.bitbucket.tokenFile.trim(),
                              repositories: config.bitbucket.repositories
                                .map((s) => s.trim())
                                .filter(Boolean),
                            }
                          : undefined,
                        azure: { ...config.azure, projects: e.target.value.split(',').map((s) => s.trim()) },
                      })
                    }
                  />
                </Field>
              </div>
            )}
            <Field label="Mapeamento de pastas para repositórios" hint="Uma por linha: caminho=repositório">
              <textarea
                value={mappingText}
                onChange={(e) => {
                  setMappingText(e.target.value);
                  update({ repoMappings: entries(e.target.value) });
                }}
              />
            </Field>
            <Field label="Sincronizar a cada (minutos)">
              <input
                type="number"
                min="1"
                value={config.syncMinutes}
                onChange={(e) => update({ syncMinutes: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="settings-section">
            <h3>
              03 <span>Calendário de trabalho</span>
            </h3>
            <Field label="Fuso horário">
              <input
                value={config.calendar.timezone}
                onChange={(e) => update({ calendar: { ...config.calendar, timezone: e.target.value } })}
              />
            </Field>
            <div className="field">
              <span>Dias úteis</span>
              <div className="weekdays">
                {['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'].map((day, i) => (
                  <button
                    type="button"
                    key={day}
                    aria-label={day}
                    aria-pressed={config.calendar.workdays.includes(i)}
                    className={config.calendar.workdays.includes(i) ? 'active' : ''}
                    onClick={() =>
                      update({
                        calendar: {
                          ...config.calendar,
                          workdays: config.calendar.workdays.includes(i)
                            ? config.calendar.workdays.filter((n) => n !== i)
                            : [...config.calendar.workdays, i],
                        },
                      })
                    }
                  >
                    {day[0]}
                  </button>
                ))}
              </div>
            </div>
            <Toggle
              label="Feriados nacionais automáticos"
              checked={config.calendar.automaticHolidays}
              onChange={(v) => update({ calendar: { ...config.calendar, automaticHolidays: v } })}
            />
            <Field label="Folgas e férias" hint="Datas sem trabalho, uma por linha no formato AAAA-MM-DD.">
              <textarea
                value={config.calendar.excludedDates.join('\n')}
                onChange={(e) =>
                  update({ calendar: { ...config.calendar, excludedDates: e.target.value.split('\n') } })
                }
              />
            </Field>
            <Field label="Feriados adicionais" hint="Uma por linha: AAAA-MM-DD=nome">
              <textarea
                value={holidayText}
                onChange={(e) => {
                  setHolidayText(e.target.value);
                  update({ calendar: { ...config.calendar, holidays: entries(e.target.value) } });
                }}
              />
            </Field>
          </div>
          <div className="settings-section">
            <h3>
              04 <span>Preferências</span>
            </h3>
            <Toggle
              label="Análise com IA"
              hint="Permite enviar dados para gerar a leitura Luna. Desativado por padrão."
              checked={config.analysis.enabled}
              onChange={(v) => update({ analysis: { ...config.analysis, enabled: v } })}
            />
            {config.analysis.enabled && (
              <>
                <Field label="Modelo de análise">
                  <input
                    value={config.analysis.model}
                    onChange={(e) => update({ analysis: { ...config.analysis, model: e.target.value } })}
                  />
                </Field>
                <Toggle
                  label="Incluir diffs na análise"
                  hint="Conteúdo de código poderá ser enviado para análise."
                  checked={config.analysis.includeDiffs}
                  onChange={(v) => update({ analysis: { ...config.analysis, includeDiffs: v } })}
                />
              </>
            )}
            <Toggle
              label="Abrir ao iniciar sessão"
              checked={config.launchAtLogin}
              onChange={(v) => update({ launchAtLogin: v })}
            />
            <Toggle
              label="Reduzir movimento"
              checked={config.reducedMotion}
              onChange={(v) => update({ reducedMotion: v })}
            />
            <div className="button-row">
              <button type="button" className="outline-button" onClick={importConfig}>
                Importar configuração
              </button>
              <button type="button" className="outline-button" onClick={exportConfig}>
                Exportar configuração
              </button>
              <button type="button" className="text-button" onClick={switchDemo}>
                {demo ? 'Sair do modo demo' : 'Explorar modo demo'}
              </button>
            </div>
          </div>
        </div>
        <div className="settings-footer">
          <button type="button" className="text-button" onClick={close}>
            Fechar
          </button>
          <button
            type="button"
            className="primary"
            disabled={!!busy && busy !== 'sync' && busy !== 'import-history'}
            onClick={save}
          >
            {busy === 'save' ? 'Salvando…' : 'Salvar configurações'} <Icon name="arrow" size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
