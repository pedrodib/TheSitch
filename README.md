<div align="center">
  <img src="src/renderer/assets/thesitch-mark.png" alt="Logotipo do TheSitch" width="112" />
  <h1>TheSitch</h1>
  <p><strong>Seu trabalho, uma cidade viva.</strong></p>
  <p>Um aplicativo desktop que transforma contribuições de engenharia em uma cidade cyberpunk.</p>
  <p>macOS · Electron · React · TypeScript · SQLite</p>
</div>

---

O **TheSitch** reúne PRs, merge requests, commits, entregas e consumo de tokens em um painel interativo. Cada repositório vira um bairro; conforme suas contribuições crescem, a cidade se desenvolve. O objetivo é facilitar a leitura do seu histórico de trabalho, com evidências e contexto.

**Volume não equivale a qualidade ou impacto.** Os indicadores descrevem os registros disponíveis. Fins de semana, feriados e folgas sem contribuições não penalizam o desempenho.

## Conteúdo

- [Funcionalidades](#funcionalidades)
- [Integrações](#integrações)
- [Começando](#começando)
- [Configuração](#configuração)
- [Como ler a cidade](#como-ler-a-cidade)
- [Importação e histórico](#importação-e-histórico)
- [Privacidade e dados](#privacidade-e-dados)
- [Desenvolvimento](#desenvolvimento)
- [Limitações](#limitações)
- [Contribuindo](#contribuindo)
- [Licença](#licença)

## Funcionalidades

- **Cidade interativa:** bairros por repositório, crescimento gradual, iluminação conforme o horário, veículos e pedestres animados.
- **Indicadores por período:** acompanhe entregas, PRs, commits e tokens; consulte os últimos 30 dias ou um intervalo personalizado.
- **Prefeitômetro:** cinco níveis de ritmo de entregas, com calendário configurável e comparação com seu histórico.
- **City Signal:** avaliação do prefeito com resumo local e análise opcional por IA via Codex CLI.
- **Ranking de Prefeitos:** posição, média e comparação com autores ativos nos repositórios GitHub acessíveis.
- **Importação transparente:** sincronização a cada 10 minutos por padrão, gravação incremental, retomada e tela detalhada de histórico.
- **Tokens de IA:** leitura local de sessões do Codex e Claude Code, incluindo subagentes, com atribuição por repositório.
- **Configuração portátil:** fontes, calendário e caminhos configuráveis, com importação e exportação de preferências.
- **Modo demonstração:** explore dados sintéticos sem conectar contas.

<details>
<summary>Ver uma prévia da cidade</summary>

![Prévia da progressão dos bairros](artifacts/city-preview.png)

Renderização do modelo com dados sintéticos para demonstrar diferentes níveis de desenvolvimento. Não é uma captura da interface completa.

</details>

## Integrações

| Fonte | Dados coletados | Autenticação |
| --- | --- | --- |
| GitHub | PRs próprios, revisões, commits e confirmação de produção quando disponível | GitHub CLI (`gh`) |
| GitLab.com / GitLab privado | MRs próprios e commits, com associação commit/MR | GitLab CLI (`glab`) |
| Bitbucket Cloud | PRs próprios e commits, com associação commit/PR | E-mail Atlassian e API token em arquivo local |
| Azure DevOps | Cards atribuídos à conta conectada | Azure CLI (`az`) e extensão `azure-devops` |
| Codex | Uso de tokens das sessões locais | Leitura de arquivos locais |
| Claude Code | Uso de tokens das sessões locais | Leitura de arquivos locais |

As fontes podem ser usadas em conjunto. GitLab e Bitbucket aceitam projetos de equipes ou contas pessoais, escolhidos explicitamente. **A integração GitHub ainda depende de organizações configuradas.** O ranking compara somente GitHub.

## Começando

### Requisitos

- **macOS em Apple Silicon** para o pacote desktop atual.
- **Node.js 24 ou superior** e **pnpm 11.18.0** para executar ou compilar o projeto.
- CLIs e contas autenticadas apenas para as integrações que você ativar.

### Executar pelo código-fonte

Após obter o código, entre na pasta do projeto:

```sh
pnpm install
pnpm dev
```

Para executar o build de produção:

```sh
pnpm build
pnpm start
```

### Gerar o aplicativo

```sh
pnpm package:zip
```

O comando gera:

- `release/mac-arm64/TheSitch.app` — aplicativo para abrir pelo Finder.
- `release/TheSitch-mac-arm64.zip` — pacote transportável.

O pacote local usa assinatura ad hoc e não é notarizado. O projeto também possui `pnpm package` para gerar DMG, dependendo dos serviços de disco do macOS.

### Primeiro uso

1. Abra **Explorar demonstração** para conhecer a interface sem conectar serviços.
2. Em **Configurações**, defina seu nome, o nome da cidade e as fontes desejadas.
3. Autentique as integrações e selecione as organizações ou repositórios que deseja acompanhar.
4. Salve e inicie a sincronização. A coleta histórica parte de **1º de janeiro de 2026**.
5. Abra **Importações** para acompanhar o que foi salvo e o que ainda está pendente.

Fechar a janela pode manter o aplicativo na bandeja. Use **⌘Q** para encerrar completamente, inclusive antes de substituir o aplicativo por uma nova versão.

## Configuração

As preferências ficam disponíveis na interface. O arquivo [`thesitch.config.example.json`](thesitch.config.example.json) oferece uma configuração inicial genérica; configurações antigas recebem os valores padrão das novas fontes.

### GitHub

Autentique o CLI:

```sh
gh auth login
```

Preencha o login e as organizações nas configurações. O app pode descobrir as organizações acessíveis à conta autenticada. Para outro host GitHub, configure o host e autentique o `gh` nele.

### GitLab

Instale o [GitLab CLI](https://docs.gitlab.com/cli/) e autentique:

```sh
glab auth login --hostname gitlab.com
```

Para uma instância privada, substitua o host. Em **Fontes e ferramentas → Conectar GitLab**, informe:

- Host, usuário autenticado e caminho do `glab`, se necessário.
- Um projeto por linha: `grupo/subgrupo/projeto` ou `usuario/projeto`.
- E-mails usados na autoria dos seus commits, incluindo endereços `noreply` quando aplicável.

O app também considera os e-mails retornados pela API da conta. Consulte as [opções oficiais de autenticação](https://docs.gitlab.com/cli/authentication/).

### Bitbucket Cloud

Não é necessário instalar um CLI. Crie um **API token Atlassian** com os escopos de leitura `read:user:bitbucket`, `read:repository:bitbucket` e `read:pullrequest:bitbucket`, seguindo a [documentação de autenticação](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).

Salve somente o token em um arquivo privado fora do projeto. Restrinja as permissões do arquivo:

```sh
chmod 600 ~/.config/thesitch/bitbucket-token
```

Em **Conectar Bitbucket Cloud**, informe o e-mail Atlassian, o UUID ou `account_id` da conta, o caminho absoluto do arquivo e um `workspace/repositorio` por linha. O identificador da conta pode ser obtido nas configurações do Bitbucket ou pela API autenticada `/2.0/user`.

O conteúdo do token não entra no SQLite nem na exportação de configurações. Não cole o token no campo de caminho ou em comandos compartilhados.

A [associação entre commits e PRs](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-commit-commit-pullrequests-get) exige **Pull Request Commit Links**, habilitado pela opção **Go to pull request** na página de um commit. Quando os vínculos estão indisponíveis ou em processamento, a etapa fica pendente para evitar contagem duplicada.

Após salvar, use **Verificar GitLab e Bitbucket salvos** para conferir a autenticação.

### Azure DevOps

Configure o `az`, sua autenticação e a extensão `azure-devops`. No aplicativo, habilite a fonte e informe a organização e os projetos. A coleta usa a conta conectada para consultar cards atribuídos a ela.

### Codex, Claude Code e análise por IA

Os caminhos padrão de leitura são:

| Ferramenta | Caminho |
| --- | --- |
| Codex | `~/.codex/sessions`, incluindo sessões arquivadas |
| Claude Code | `~/.claude/projects` |

Use o mapeamento de pastas para associar sessões a repositórios. Nomes ambíguos entre plataformas podem ser resolvidos usando o ID do repositório.

A **Análise com IA** é opcional e usa o Codex CLI autenticado, com modelo configurável. Quando habilitada, envia os metadados selecionados para análise. O envio de diffs tem uma opção separada e está disponível somente para GitHub. O consumo das análises do próprio TheSitch aparece separado dos demais tokens.

### Calendário

Configure fuso horário, dias úteis, férias, folgas e feriados adicionais. Feriados nacionais brasileiros podem ser obtidos automaticamente pela BrasilAPI; pontos facultativos não são tratados automaticamente como folga.

Ausência de contribuições em dias não úteis é neutra. Períodos sem cobertura suficiente ficam em calibração, e o dia atual é tratado como provisório.

## Como ler a cidade

| Elemento | Significado |
| --- | --- |
| Bairro | Um repositório com contribuições identificadas |
| Ocupação e altura | Desenvolvimento acumulado com base em PRs e commits independentes, respeitando agrupamentos |
| Módulos luminosos | Representação de commits; a etiqueta mantém o total, mesmo quando o desenho atinge seu limite visual |
| Energia | Consumo de tokens, com detalhamento por ferramenta e atribuição |
| Prefeitômetro | Ritmo de entregas em relação ao histórico, não qualidade ou impacto de negócio |
| City Signal | Resumo das evidências e avaliação do prefeito |

O filtro de datas altera indicadores e histórias, **sem fazer o bairro acumulado encolher**. O replay permite observar um momento anterior. Commits associados a PRs são registrados, mas não geram entregas independentes duplicadas.

Veículos e pedestres são ambientação. A iluminação acompanha o horário atual no fuso configurado, independentemente do período selecionado.

### Controles

| Ação | Controle |
| --- | --- |
| Aproximar / afastar | Scroll ou botões de zoom |
| Rotacionar | Botão direito + arrasto horizontal |
| Mover | Botão esquerdo + arrasto no fundo |
| Localizar um repositório | Seletor **Ir para bairro** ou lista de bairros |
| Restaurar câmera | **Centralizar** |

A cidade exibe oito bairros por página para limitar o custo gráfico. Movimento reduzido pode ser habilitado nas preferências.

## Importação e histórico

A sincronização ocorre a cada **10 minutos por padrão**, com intervalo configurável. Cada fonte possui seu próprio histórico e checkpoint.

- Dados são gravados durante a coleta, antes da conclusão de toda a fonte.
- Consultas concluídas podem ser reaproveitadas na retomada de uma tentativa interrompida.
- O checkpoint só avança quando a fonte conclui suas etapas.
- Deltas usam sobreposição de 24 horas para reconferir alterações recentes.
- Pausar ou encerrar o app preserva os dados já gravados.
- A tela **Importações** informa períodos, etapas, registros salvos, erros e pendências.

O ranking GitHub roda separadamente, a cada duas horas por padrão, com opções de uma ou três horas e atualização manual. Ele considera autores humanos com PRs mergeados nos repositórios acessíveis, não todos os funcionários da organização.

Use a reconferência completa quando precisar revisar dados antigos que possam ter mudado fora da janela incremental. Sucesso de uma consulta não garante recuperação de dados apagados ou inacessíveis.

## Privacidade e dados

O TheSitch usa **SQLite local**, com WAL. Por padrão, os dados ficam no diretório `userData` do Electron, normalmente:

```text
~/Library/Application Support/TheSitch/
├── thesitch.sqlite
└── operations.jsonl
```

- Credenciais permanecem nos CLIs autenticados ou no arquivo externo do token Bitbucket.
- A leitura de sessões locais armazena contadores e metadados de uso, sem copiar as conversas para o banco.
- Metadados de contribuições, como títulos e descrições de PRs, são armazenados localmente.
- A análise por IA pode enviar os metadados selecionados ao serviço do Codex quando habilitada.
- O aplicativo não publica comentários, cria PRs ou altera cards nos serviços conectados.

Encerre o app antes de fazer um backup manual do banco. `THESITCH_DATA_DIR` permite usar um diretório separado para testes.

Configurações exportadas podem conter nomes, organizações e caminhos locais: revise antes de compartilhá-las. Ao trocar de pessoa na mesma instalação, use outro identificador de workspace. Desabilitar uma fonte oculta seus dados sem apagá-los.

## Desenvolvimento

### Comandos

| Comando | Finalidade |
| --- | --- |
| `pnpm dev` | Executar com recarga durante o desenvolvimento |
| `pnpm check` | Verificar lint e formatação |
| `pnpm format` | Aplicar correções de formatação e lint |
| `pnpm typecheck` | Verificar tipos TypeScript |
| `pnpm test` | Executar testes automatizados |
| `pnpm test:worker` | Testar worker, IPC e SQLite no runtime do Electron |
| `pnpm test:e2e` | Executar testes de interface com Playwright |
| `pnpm build` | Gerar build de produção |
| `pnpm package:dir` | Gerar o aplicativo macOS |
| `pnpm package:zip` | Gerar aplicativo e ZIP |
| `pnpm package` | Gerar DMG |

Testes de janela exigem uma sessão gráfica compatível. Os testes dos conectores usam respostas simuladas; valide também com uma conta de teste antes de afirmar compatibilidade com uma instância específica.

### Estrutura

```text
src/
├── main/           # Processo Electron, IPC e coordenação dos serviços
├── backend/        # SQLite, métricas, histórico e ranking
├── integrations/   # Conectores, CLIs e leitura de sessões locais
├── renderer/       # Interface React e renderização da cidade
└── shared/         # Tipos, validação, calendário e regras compartilhadas
tests/              # Testes de domínio, integrações e interface
scripts/            # Verificações e utilitários de build
build/              # Ícones e recursos de empacotamento
```

O domínio possui workspaces e membros para separar identidades. **Multiplayer ainda não está implementado:** não há servidor, convites ou sincronização entre computadores.

## Limitações

- O pacote atual é voltado ao macOS Apple Silicon; Windows, Linux e Macs Intel não têm distribuição validada.
- Bitbucket Data Center não é suportado.
- Revisões, deployments e estatísticas de diff de GitLab/Bitbucket não são coletados. O ranking permanece exclusivo do GitHub.
- GitLab atribui commits pelos e-mails configurados ou retornados pela conta. Bitbucket usa o vínculo do autor com a conta; não infere identidade pelo nome.
- A coleta de commits do Bitbucket pode percorrer o inventário para aplicar o recorte local. Seu custo incremental pode ser maior que o das outras fontes.
- As coleções GitLab/Bitbucket têm limite defensivo de 100 páginas. Atingir esse limite deixa a etapa pendente, sem declarar cobertura completa.
- Índices, permissões, paginação das APIs e registros removidos limitam a cobertura. Commits antigos publicados tardiamente podem exigir reconferência.
- Os formatos locais do Codex e Claude Code podem mudar. Só é possível recuperar arquivos disponíveis no computador.
- Não há integração com receita, incidentes ou analytics de produto: impacto de negócio não é inferido de volume de PRs, commits ou tokens.

## Contribuindo

Contribuições são bem-vindas. Antes de propor uma mudança:

1. Descreva o problema e o comportamento esperado; para bugs, inclua passos de reprodução e versões relevantes.
2. Mantenha a alteração focada e adicione testes para mudanças de comportamento.
3. Execute `pnpm check`, `pnpm typecheck` e `pnpm test`.
4. Para alterações no processo Electron ou na persistência, execute também `pnpm test:worker`.
5. Explique como validou a mudança e informe limitações conhecidas.

Não inclua tokens, bancos de dados pessoais, conversas ou informações privadas de repositórios em exemplos, issues ou pull requests.

## Licença

Este repositório ainda não possui um arquivo `LICENSE`. Uma licença precisa ser definida antes de sua distribuição como projeto open source.
