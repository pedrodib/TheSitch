# Verificação das importações — v0.3.0

## Resultado

94 testes passaram (13 arquivos). Lint e verificação de tipos passaram. O fluxo novo foi exercitado com o coletor GitHub real do projeto, respostas de rede controladas e SQLite real temporário, incluindo fechamento e reabertura do banco.

O smoke test do worker compilado passou com Electron, SQLite, IPC e consulta do histórico de importações. A assinatura do aplicativo empacotado passou em `codesign --verify --deep --strict`.

Casos verificados:

- falha no segundo período, preservação do primeiro e retomada após reabrir o SQLite;
- nenhuma nova consulta ao período já concluído e nenhuma duplicação das contribuições;
- checkpoint global só avança após conclusão de toda a fonte;
- tentativa parcial não substitui a última sincronização bem-sucedida;
- próxima execução após reinício usa delta, sem refazer automaticamente todo o histórico;
- busca incompleta não entra no cache e paginação com quantidade divergente não é aceita;
- mudança de escopo invalida diário/cache e checkpoints relevantes;
- interrupção preserva dados e é exibida como interrupção, sem indicar atualizado;
- leitura local reconhece arquivo novo com timestamps antigos e reaproveita parsing de arquivo inalterado;
- contagem de tokens deduplicada e commits vinculados a PRs sem duplicar entregas;
- esperas por cota e cancelamento já cobertos pelos testes do adaptador GitHub;
- abertura e fechamento da tela de importações pela interface React.

## Limites da validação

O CLI no ambiente de execução não conseguiu acessar `api.github.com` (`error connecting to api.github.com`). Não foi possível confrontar a quantidade local com uma consulta externa independente. As respostas remotas dos testes foram controladas, não consultas à conta real.

O ambiente de automação gráfica está indisponível. A verificação visual da janela nativa não foi concluída. Os testes React/IPC/SQLite e o pacote compilado são verificações independentes.

A primeira execução da v0.3 reconfere o inventário antigo, preservando os dados. A partir daí, cada faixa concluída fica registrada para retomada. Dados sem permissão, apagados, ausentes do disco ou não retornados pelos índices das APIs não podem ser garantidos como recuperados. O aplicativo identifica cobertura das consultas realizadas, não ausência de dados inacessíveis.

## Limite de histórico

Coleta limitada a partir de 01/01/2026. Na retomada, etapas anteriores a 2026 são descartadas, preservando etapas concluídas dentro do período. Consultas incrementais também respeitam esse limite. Tokens locais anteriores a essa data não são importados. Registros previamente gravados não são apagados.
