import type { AppConfig } from './types';

export const HISTORY_START = '2026-01-01T00:00:00.000Z';

export function defaultConfig(home: string): AppConfig {
  return {
    version: 1,
    workspace: {
      id: 'local-workspace',
      name: 'La Serenissima',
      members: [{ id: 'local-member', name: 'Prefeito', externalLogin: '' }],
    },
    organizations: [],
    githubHost: 'github.com',
    gitlab: { enabled: false, host: 'gitlab.com', projects: [], cli: 'glab', username: '' },
    bitbucket: { enabled: false, repositories: [], email: '', tokenFile: '', accountId: '' },
    azure: { enabled: false, organization: '', projects: [] },
    cli: { gh: 'gh', az: 'az', codex: 'codex' },
    codexSessionsPath: `${home}/.codex/sessions`,
    claudeSessionsPath: `${home}/.claude/projects`,
    repoMappings: {},
    calendar: {
      timezone: 'America/Sao_Paulo',
      workdays: [1, 2, 3, 4, 5],
      automaticHolidays: true,
      excludedDates: [],
      holidays: {},
    },
    syncMinutes: 10,
    analysis: { enabled: false, model: 'gpt-6-luna', includeDiffs: false },
    reducedMotion: false,
    launchAtLogin: false,
    onboardingComplete: false,
  };
}
