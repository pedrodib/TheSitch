import { useEffect, useState } from 'react';
import type { MayorRanking, Period } from '../shared/types';
import './mayor-ranking.css';

const number = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : 'Ainda não consultado';
export function MayorRankingPanel({ period, demo }: { period: Period; demo: boolean }) {
  const [data, setData] = useState<MayorRanking | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null);
    const load = () =>
      window.theSitch
        .getMayorRanking(period)
        .then((value) => {
          if (active) {
            setData(value);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    if (!demo) void load();
    const timer = setInterval(() => {
      if (!demo) void load();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [period, demo]);
  const mine = data?.rows.find((row) => row.me);
  return (
    <section className="mayor-league" aria-label="Ranking de Prefeitos">
      <header>
        <span className="eyebrow">LIGA DAS CIDADES · GITHUB</span>
        <h2>Ranking de Prefeitos</h2>
        <p>
          PRs mergeados · {period.start} → {period.end} · dias em UTC
        </p>
      </header>
      {demo ? (
        <p>O ranking consulta dados reais do GitHub. Saia da demonstração para comparar sua cidade.</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {!data ? (
            <p>Carregando classificação…</p>
          ) : (
            <>
              <p>
                Esta liga compara somente GitHub. Contribuições GitLab e Bitbucket aparecem na cidade e nos
                indicadores pessoais.
              </p>
              <div className="league-status" role="status">
                <strong>
                  {data.running
                    ? 'Consultando a liga'
                    : data.partial
                      ? 'Classificação provisória'
                      : data.completedDays
                        ? 'Cobertura consultada'
                        : 'Aguardando consulta'}
                </strong>
                <span>{data.phase}</span>
                <small>
                  {data.completedDays}/{data.totalDays} dias por organização · {data.repositories}{' '}
                  repositórios com PRs · {data.rows.length} autores ativos
                </small>
              </div>
              {data.error && <p className="league-warning">{data.error}</p>}
              <div className="league-stats">
                <div>
                  <small>SUA CLASSIFICAÇÃO</small>
                  <strong>{mine ? `${mine.rank}º` : '—'}</strong>
                  <span>
                    de {number(data.rows.length)} {data.rows.length === 1 ? 'prefeito' : 'prefeitos'}
                  </span>
                  <span>{number(data.mine)} PRs mergeados</span>
                </div>
                <div>
                  <small>MÉDIA DA LIGA</small>
                  <strong>{number(data.mean)}</strong>
                  <span>mediana: {number(data.median)}</span>
                </div>
                <div>
                  <small>VOCÊ × MÉDIA</small>
                  <strong>
                    {data.difference === null
                      ? '—'
                      : `${data.difference > 0 ? '+' : ''}${number(data.difference)}%`}
                  </strong>
                  <span>
                    {data.partial
                      ? 'resultado provisório'
                      : data.difference === null
                        ? 'sem base para comparar'
                        : data.difference >= 0
                          ? 'acima ou na média'
                          : 'abaixo da média'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="outline-button league-refresh"
                disabled={refreshing || data.running}
                onClick={async () => {
                  setRefreshing(true);
                  setError('');
                  try {
                    setData(await window.theSitch.refreshMayorRanking(period));
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setRefreshing(false);
                  }
                }}
              >
                {refreshing || data.running ? 'Atualizando ranking…' : 'Atualizar ranking agora'}
              </button>
              <label className="league-frequency">
                Atualizar a cada{' '}
                <select
                  aria-label="Intervalo do ranking"
                  value={data.intervalHours}
                  onChange={async (e) => {
                    try {
                      await window.theSitch.setRankingInterval(Number(e.target.value));
                      setData(await window.theSitch.getMayorRanking(period));
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  {[1, 2, 3].map((hours) => (
                    <option key={hours} value={hours}>
                      {hours} {hours === 1 ? 'hora' : 'horas'}
                    </option>
                  ))}
                </select>
              </label>
              <p className="league-dates">
                Cobertura mais antiga: {date(data.checkedAt)}
                <br />
                Próxima rodada a partir de: {date(data.nextAt)}
              </p>
              <div className="league-table">
                <table>
                  <thead>
                    <tr>
                      <th>Posição</th>
                      <th>Prefeito / cidade</th>
                      <th>PRs</th>
                      <th>× média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.login} className={row.me ? 'is-me' : ''}>
                        <td>{row.rank}º</td>
                        <td>
                          <span className="league-city-icon" aria-hidden="true">
                            ▥
                          </span>{' '}
                          {row.login}
                          {row.me && <b> VOCÊ</b>}
                        </td>
                        <td>{row.merged}</td>
                        <td>{data.mean ? `${number((row.merged / data.mean - 1) * 100)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.rows.length && <p>Nenhum prefeito encontrado no período consultado.</p>}
              </div>
              <footer>
                <p>{data.organizations.join(' · ') || 'Configure uma organização do GitHub.'}</p>
                <p>
                  Autores humanos com ao menos um PR mergeado nos repositórios acessíveis. Bots excluídos;
                  empates compartilham a posição. A média representa esses autores, não todos os funcionários.
                </p>
                <p>
                  Classificação de volume de entregas, não de qualidade ou impacto. Até 20 consultas por
                  rodada; pendências continuam no próximo ciclo. Dias recentes são revistos a cada rodada;
                  dias antigos, semanalmente. Cobertura limitada ao índice e às permissões do GitHub, desde
                  01/01/2026.
                </p>
              </footer>
            </>
          )}
        </>
      )}
    </section>
  );
}
