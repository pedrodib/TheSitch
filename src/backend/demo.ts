import type { AppConfig, Contribution, Repository, TokenUsage } from '../shared/types';

/** Synthetic examples generated relative to today and never persisted. */
export function createDemoData(config: AppConfig): {
  repositories: Repository[];
  contributions: Contribution[];
  tokens: TokenUsage[];
  coverageStart: string;
} {
  const workspaceId = config.workspace.id;
  const memberId = config.workspace.members[0]?.id ?? 'demo-member';
  const repositories: Repository[] = [
    {
      id: 'demo-repo-1',
      workspaceId,
      name: 'praca-digital',
      fullName: 'prefeitura/praca-digital',
      url: '',
      description: 'Serviços digitais para a cidade',
    },
    {
      id: 'demo-repo-2',
      workspaceId,
      name: 'arquivo-publico',
      fullName: 'prefeitura/arquivo-publico',
      url: '',
      description: 'Organização do acervo municipal',
    },
  ];
  const contributions: Contribution[] = [];
  const tokens: TokenUsage[] = [];
  const now = new Date();
  for (let i = 0; i < 90; i += 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - i);
    date.setUTCHours(15, 0, 0, 0);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const occurredAt = date.toISOString();
    const repositoryId = repositories[i % 2].id;
    if (i % 3 !== 0)
      contributions.push({
        id: `demo-pr-${i}`,
        workspaceId,
        memberId,
        repositoryId,
        source: 'github',
        externalId: `demo-${i}`,
        kind: 'pull_request',
        title: ['Ajustar atendimento digital', 'Organizar documentos', 'Melhorar busca de serviços'][i % 3],
        body: 'Exemplo de atividade demonstrativa.',
        url: '',
        occurredAt,
        updatedAt: occurredAt,
        state: i % 4 === 0 ? 'building' : 'merged',
        additions: 20 + i,
        deletions: i % 12,
        participants: [memberId],
        labels: ['demonstração'],
      });
    if (i % 3 !== 0)
      contributions.push({
        id: `demo-commit-${i}`,
        workspaceId,
        memberId,
        repositoryId,
        source: 'github',
        externalId: `demo-commit-${i}`,
        kind: 'commit',
        title: 'Ajuste no serviço',
        body: '',
        url: '',
        occurredAt,
        updatedAt: occurredAt,
        state: 'merged',
        additions: 8,
        deletions: 2,
        participants: [memberId],
        labels: ['demonstração'],
        associatedPullRequests: [i + 1],
      });
    if (i % 4 === 0)
      contributions.push({
        id: `demo-review-${i}`,
        workspaceId,
        memberId,
        repositoryId,
        source: 'github',
        externalId: `demo-review-${i}`,
        kind: 'review',
        title: 'Revisão de proposta',
        body: '',
        url: '',
        occurredAt,
        updatedAt: occurredAt,
        state: 'inspection',
        additions: 0,
        deletions: 0,
        participants: [memberId],
        labels: [],
      });
    if (i % 2 === 0)
      tokens.push({
        id: `demo-token-${i}`,
        workspaceId,
        memberId,
        sessionId: `demo-session-${i}`,
        repositoryId,
        occurredAt,
        input: 4000,
        cached: 1000,
        output: 1200,
        total: 5200,
        model: 'exemplo',
        isTheSitch: false,
        provider: i % 4 === 0 ? 'claude' : 'codex',
      });
  }
  const coverageStart = new Date(now);
  coverageStart.setUTCDate(coverageStart.getUTCDate() - 90);
  return { repositories, contributions, tokens, coverageStart: coverageStart.toISOString().slice(0, 10) };
}
