import { useState } from 'react';
import type { AppConfig } from '../shared/types';

/** Provider credentials stay in the authenticated CLI or an external token file. */
export function ForgeSettings({
  config,
  update,
}: {
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [diagnosis, setDiagnosis] = useState('');
  const gitlab = config.gitlab ?? {
    enabled: false,
    host: 'gitlab.com',
    projects: [],
    cli: 'glab',
    username: '',
    commitEmails: [],
  };
  const bitbucket = config.bitbucket ?? {
    enabled: false,
    repositories: [],
    email: '',
    tokenFile: '',
    accountId: '',
  };
  return (
    <>
      <button
        type="button"
        className="outline-button"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          try {
            const results = await window.theSitch.diagnostics();
            setDiagnosis(
              results
                .filter((r) => r.source === 'gitlab' || r.source === 'bitbucket')
                .map((r) => `${r.source}: ${r.message}`)
                .join(' · ') ||
                'Salve as configurações com GitLab ou Bitbucket habilitado antes de verificar.',
            );
          } catch {
            setDiagnosis('Não foi possível verificar as integrações. Confira as configurações salvas.');
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? 'Verificando conexões…' : 'Verificar GitLab e Bitbucket salvos'}
      </button>
      {diagnosis && <p role="status">{diagnosis}</p>}
      <label className="toggle">
        <span>
          <strong>Conectar GitLab</strong>
          <small>GitLab.com ou instância privada</small>
        </span>
        <input
          type="checkbox"
          checked={gitlab.enabled}
          onChange={(e) => update({ gitlab: { ...gitlab, enabled: e.target.checked } })}
        />
        <i />
      </label>
      {gitlab.enabled && (
        <>
          <p>
            Autentique no terminal com <code>glab auth login --hostname {gitlab.host}</code>. O app usa essa
            sessão, sem copiar o token.
          </p>
          <div className="form-grid">
            <label className="field">
              <span>Host GitLab</span>
              <input
                value={gitlab.host}
                onChange={(e) => update({ gitlab: { ...gitlab, host: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>Usuário GitLab</span>
              <input
                value={gitlab.username}
                onChange={(e) => update({ gitlab: { ...gitlab, username: e.target.value } })}
              />
              <small>Deve corresponder à conta autenticada no glab.</small>
            </label>
            <label className="field">
              <span>Caminho do GitLab CLI</span>
              <input
                value={gitlab.cli}
                onChange={(e) => update({ gitlab: { ...gitlab, cli: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>E-mails de autoria de commits GitLab</span>
              <textarea
                value={(gitlab.commitEmails ?? []).join('\n')}
                onChange={(e) => update({ gitlab: { ...gitlab, commitEmails: e.target.value.split('\n') } })}
              />
              <small>Um e-mail seu por linha, incluindo noreply se usado nos commits.</small>
            </label>
          </div>
          <label className="field">
            <span>Projetos GitLab</span>
            <textarea
              value={gitlab.projects.join('\n')}
              onChange={(e) => update({ gitlab: { ...gitlab, projects: e.target.value.split('\n') } })}
            />
            <small>
              Um caminho por linha: grupo/subgrupo/projeto ou usuario/projeto. Somente os projetos listados
              serão consultados.
            </small>
          </label>
        </>
      )}
      <label className="toggle">
        <span>
          <strong>Conectar Bitbucket Cloud</strong>
          <small>Repositórios de workspaces ou pessoais; Data Center não suportado</small>
        </span>
        <input
          type="checkbox"
          checked={bitbucket.enabled}
          onChange={(e) => update({ bitbucket: { ...bitbucket, enabled: e.target.checked } })}
        />
        <i />
      </label>
      {bitbucket.enabled && (
        <>
          <p>
            Crie um API token da Atlassian com permissões de leitura de usuário, repositórios e pull requests.
            Salve apenas o token em um arquivo local privado (permissão 600). Informe o caminho abaixo; o
            conteúdo não entra no banco nem na exportação.
          </p>
          <div className="form-grid">
            <label className="field">
              <span>E-mail Atlassian</span>
              <input
                type="email"
                value={bitbucket.email}
                onChange={(e) => update({ bitbucket: { ...bitbucket, email: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>UUID ou account_id do Bitbucket</span>
              <input
                value={bitbucket.accountId}
                onChange={(e) => update({ bitbucket: { ...bitbucket, accountId: e.target.value } })}
              />
              <small>
                ID da conta pessoal, disponível nas configurações da conta ou na API /2.0/user. Não é o nome
                de exibição.
              </small>
            </label>
            <label className="field">
              <span>Arquivo do API token Bitbucket</span>
              <input
                value={bitbucket.tokenFile}
                onChange={(e) => update({ bitbucket: { ...bitbucket, tokenFile: e.target.value } })}
                placeholder="/Users/seu-usuario/.config/thesitch/bitbucket-token"
              />
              <small>Caminho absoluto, sem colar o token neste campo.</small>
            </label>
          </div>
          <label className="field">
            <span>Repositórios Bitbucket</span>
            <textarea
              value={bitbucket.repositories.join('\n')}
              onChange={(e) =>
                update({ bitbucket: { ...bitbucket, repositories: e.target.value.split('\n') } })
              }
            />
            <small>Um workspace/repositorio por linha.</small>
          </label>
        </>
      )}
      {(gitlab.enabled || bitbucket.enabled) && (
        <p>
          As novas fontes alimentam a cidade e os indicadores pessoais. Revisões, deployments e diffs para IA
          ainda não são coletados nessas plataformas. No Bitbucket, commits cobrem o histórico alcançável
          pelas branches e tags; commits sem vínculo de autoria com sua conta não são atribuídos. No GitLab, a
          autoria de commits usa os e-mails configurados e os retornados pela conta. A associação commit/PR no
          Bitbucket exige Pull Request Commit Links (opção “Go to pull request” na página de um commit). O
          Ranking de Prefeitos continua comparando somente GitHub. Ao trocar de conta, use outro identificador
          do espaço.
        </p>
      )}
    </>
  );
}
