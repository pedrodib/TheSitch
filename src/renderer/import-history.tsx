import { useEffect, useState } from 'react';
import type { ImportHistory, ImportRun, ImportSourceHistory } from '../shared/types';

const names: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket Cloud',
  codex: 'Codex',
  claude: 'Claude Code',
  azure: 'Azure DevOps',
};
const kinds: Record<string, string> = {
  pull_request: 'PRs',
  review: 'revisões',
  commit: 'commits',
  work_item: 'cards',
  tokens: 'registros de uso',
};
const stateNames: Record<string, string> = {
  pending: 'Aguardando',
  running: 'Importando',
  waiting: 'Aguardando cota',
  paused: 'Pausado',
  interrupted: 'Interrompido',
  failed: 'Com pendências',
  complete: 'Concluído',
};
const date = (value: string | null) =>
  value
    ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleString('pt-BR')
    : 'Ainda não confirmado';
export function importLabel(source: ImportSourceHistory, now: number, interval: number): string {
  if (!source.enabled) return 'Desativado';
  if (source.run && source.run.state !== 'complete') return stateNames[source.run.state];
  if (!source.historyComplete) return 'Histórico não conferido';
  if (!source.checkedThrough || now - Date.parse(source.checkedThrough) > interval * 60000)
    return 'Precisa atualizar';
  return 'Atualizado';
}
export function ImportSummary({ history, onOpen }: { history: ImportHistory | null; onOpen: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const active = history?.sources.find((s) => s.run?.state === 'running' || s.run?.state === 'waiting');
  const pending = history?.sources.filter(
    (s) => s.enabled && importLabel(s, now, history.syncMinutes) !== 'Atualizado',
  ).length;
  return (
    <button
      type="button"
      className="import-summary"
      onClick={onOpen}
      aria-label="Abrir histórico de importações"
    >
      <span>
        IMPORTAÇÕES /{' '}
        {history?.paused
          ? 'PAUSADAS'
          : history?.running
            ? 'EM ANDAMENTO'
            : pending
              ? 'COM PENDÊNCIAS'
              : 'STATUS'}
      </span>
      <strong>
        {active
          ? `${names[active.source]} · ${active.run?.phase}`
          : pending
            ? `${pending} fonte(s) precisam de atenção`
            : history
              ? 'Fontes conferidas recentemente'
              : 'Consultando estado local…'}
      </strong>
      <small>Ver períodos, quantidades e pendências →</small>
    </button>
  );
}
function Steps({ run }: { run: ImportRun }) {
  const [showComplete, setShowComplete] = useState(false);
  const complete = run.steps.filter((step) => step.state === 'complete').length;
  return (
    <div>
      <p>
        {complete} etapas concluídas · {run.steps.length - complete} pendentes
      </p>
      <label className="import-filter">
        <input type="checkbox" checked={showComplete} onChange={(e) => setShowComplete(e.target.checked)} />{' '}
        Mostrar etapas concluídas
      </label>
      <div className="import-steps">
        {run.steps.length ? (
          run.steps
            .filter((step) => showComplete || step.state !== 'complete')
            .map((step) => (
              <div className="import-step" key={step.id}>
                <div>
                  <strong>{step.label}</strong>
                  <span data-state={step.state}>{stateNames[step.state]}</span>
                </div>
                <small>
                  {step.from ? date(step.from) : 'Arquivos disponíveis no Mac'} → {date(step.to)}
                </small>
                <p>
                  {step.processed.toLocaleString('pt-BR')} processados /{' '}
                  {step.total === null ? 'total ainda não descoberto' : step.total.toLocaleString('pt-BR')}
                </p>
                {step.total !== null && step.total > 0 && (
                  <progress max={step.total} value={step.processed} />
                )}
                <small>{step.detail}</small>
              </div>
            ))
        ) : (
          <p className="import-note">Inventário ainda não iniciado. Não há um total confirmado.</p>
        )}
      </div>
    </div>
  );
}
export function ImportHistoryScreen({
  history,
  onClose,
  onSync,
  onPause,
  error,
}: {
  history: ImportHistory | null;
  onClose: () => void;
  onSync: (full?: boolean) => void;
  onPause: (paused: boolean) => void;
  error: string;
}) {
  const [source, setSource] = useState('github');
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const selected = history?.sources.find((s) => s.source === source);
  const run = selected?.run;
  return (
    <div className="import-screen" role="dialog" aria-modal="true" aria-label="Histórico de importações">
      <header>
        <div>
          <small>CENTRAL DE SINCRONIZAÇÃO</small>
          <h1>Histórico de importações</h1>
          <p>O que já está salvo, o que foi conferido e o que ainda falta.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar histórico">
          ×
        </button>
      </header>
      {error && (
        <div role="alert" className="import-error">
          {error}
        </div>
      )}
      <div className="import-actions">
        <button
          type="button"
          disabled={!history || history.running || history.paused}
          onClick={() => onSync()}
        >
          Atualizar / retomar pendências
        </button>
        <button type="button" disabled={!history} onClick={() => onPause(!history?.paused)}>
          {history?.paused ? 'Retomar importações' : 'Pausar importações'}
        </button>
        <button
          type="button"
          disabled={!history || history.running || history.paused}
          onClick={() => onSync(true)}
        >
          Reconferir histórico completo
        </button>
        <span>
          Verificação automática a cada {history?.syncMinutes ?? 10} min ·{' '}
          {history?.paused ? 'Pausada' : history?.running ? 'Em andamento' : 'Aguardando próxima verificação'}
        </span>
      </div>
      <div className="import-sources">
        {history?.sources.map((item) => (
          <button
            type="button"
            key={item.source}
            aria-pressed={source === item.source}
            onClick={() => setSource(item.source)}
          >
            <strong>{names[item.source]}</strong>
            <span>{importLabel(item, now, history.syncMinutes)}</span>
            <small>{item.stored.records.toLocaleString('pt-BR')} registros salvos</small>
          </button>
        ))}
      </div>
      {selected && (
        <>
          <div className="import-facts">
            <section>
              <small>NO BANCO, SEM DUPLICAR TENTATIVAS</small>
              <h2>{selected.stored.records.toLocaleString('pt-BR')} registros</h2>
              <p>
                {Object.entries(selected.stored.kinds)
                  .map(([kind, count]) => `${count.toLocaleString('pt-BR')} ${kinds[kind] ?? kind}`)
                  .join(' · ') || 'Nenhum registro salvo'}
              </p>
              <p>
                Datas dos registros: {date(selected.stored.first)} até {date(selected.stored.last)}
              </p>
            </section>
            <section>
              <small>COBERTURA VERIFICADA</small>
              <h2>{selected.historyComplete ? 'Histórico consultado' : 'Histórico ainda não confirmado'}</h2>
              <p>Atualizações consultadas até: {date(selected.checkedThrough)}</p>
              <p>Última conclusão sem falha: {date(selected.lastSuccessAt)}</p>
            </section>
          </div>
          {run && (
            <section className="import-current">
              <div className="import-run-title">
                <h2>{run.mode === 'history' ? 'Conferência do histórico' : 'Atualização incremental'}</h2>
                <b data-state={run.state}>{stateNames[run.state]}</b>
              </div>
              <p>
                {run.since
                  ? `${date(run.since)} → ${date(run.until)}`
                  : `Histórico desde 01/01/2026 → ${date(run.until)}`}
              </p>
              <p>{run.phase}</p>
              <small>
                {run.requests} leituras realizadas · {run.reusedRequests} reaproveitadas · início{' '}
                {date(run.startedAt)}
              </small>
              {run.retryAt && (
                <p>
                  Nova tentativa após a cota liberar: <strong>{date(run.retryAt)}</strong>
                </p>
              )}
              {run.errors.map((message) => (
                <p className="import-error" key={message}>
                  {message}
                </p>
              ))}
              <Steps run={run} />
            </section>
          )}
          {!run && (
            <p className="import-note">
              Os registros antigos foram preservados. Esta versão ainda precisa conferir o inventário para
              comprovar a cobertura. Use “Atualizar / retomar pendências”.
            </p>
          )}
          <details className="import-recent">
            <summary>Execuções anteriores ({selected.recent.length})</summary>
            {selected.recent.map((previous) => (
              <details key={`${previous.id}:${previous.finishedAt}`}>
                <summary>
                  {date(previous.startedAt)} · {previous.mode === 'history' ? 'Histórico' : 'Incremental'} ·{' '}
                  {stateNames[previous.state]}
                </summary>
                <p>
                  Consultado até {date(previous.until)} · {previous.phase}
                </p>
                <Steps run={previous} />
              </details>
            ))}
          </details>
        </>
      )}
      <p className="import-note">
        “Atualizado” significa conferido dentro do intervalo de sincronização, não uma leitura em tempo real.
        O total só é informado depois da descoberta. GitHub/Azure cobrem os dados acessíveis às contas
        conectadas; arquivos locais cobrem os arquivos disponíveis no Mac. Recursos apagados, inacessíveis ou
        omitidos pela busca não podem ser comprovados.
      </p>
    </div>
  );
}
