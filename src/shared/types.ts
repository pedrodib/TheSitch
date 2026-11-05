export type Source = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'codex' | 'claude';
export type ContributionKind = 'pull_request' | 'review' | 'commit' | 'work_item';
export type DeliveryState = 'building' | 'inspection' | 'merged' | 'deployed' | 'closed';
export interface Member {
  id: string;
  name: string;
  externalLogin: string;
}
export interface Workspace {
  id: string;
  name: string;
  members: Member[];
}
export interface AppConfig {
  version: 1;
  workspace: Workspace;
  organizations: string[];
  githubHost: string;
  gitlab?: {
    enabled: boolean;
    host: string;
    projects: string[];
    cli: string;
    username: string;
    commitEmails?: string[];
  };
  bitbucket?: {
    enabled: boolean;
    repositories: string[];
    email: string;
    tokenFile: string;
    accountId: string;
  };
  azure: { enabled: boolean; organization: string; projects: string[] };
  cli: { gh: string; az: string; codex: string };
  codexSessionsPath: string;
  claudeSessionsPath?: string;
  repoMappings: Record<string, string>;
  calendar: {
    timezone: string;
    workdays: number[];
    automaticHolidays: boolean;
    excludedDates: string[];
    holidays: Record<string, string>;
    automaticHolidayDates?: Record<string, string>;
  };
  syncMinutes: number;
  analysis: { enabled: boolean; model: string; includeDiffs: boolean };
  reducedMotion: boolean;
  launchAtLogin: boolean;
  onboardingComplete: boolean;
}
export interface Repository {
  source?: 'github' | 'gitlab' | 'bitbucket';
  id: string;
  workspaceId: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
}
export interface Contribution {
  id: string;
  workspaceId: string;
  memberId: string;
  repositoryId: string;
  source: Source;
  externalId: string;
  kind: ContributionKind;
  title: string;
  body: string;
  url: string;
  occurredAt: string;
  updatedAt: string;
  state: DeliveryState;
  mergedAt?: string;
  deployedAt?: string;
  additions: number;
  deletions: number;
  linkedWorkItem?: string;
  associatedPullRequests?: number[];
  groupId?: string | null;
  participants: string[];
  labels: string[];
}
export interface TokenUsage {
  id: string;
  workspaceId: string;
  memberId: string;
  sessionId: string;
  repositoryId: string | null;
  occurredAt: string;
  input: number;
  cached: number;
  output: number;
  total: number;
  model: string;
  isTheSitch: boolean;
  provider?: 'codex' | 'claude';
  cacheWrite?: number;
}
export interface Evidence {
  id: string;
  title: string;
  url: string;
}
export interface Assessment {
  headline: string;
  summary: string;
  caveat: string;
  priority: string;
  rhythm: 'above' | 'usual' | 'below' | 'insufficient' | 'neutral';
  confidence: 'low' | 'moderate' | 'high';
  evidenceIds: string[];
  source: 'local' | 'luna';
  provisional: boolean;
  usage?: { input: number; cached: number; output: number; total: number };
}
export interface Period {
  rolling?: boolean;
  start: string;
  end: string;
}
export interface Metrics {
  deliveries: number;
  pullRequests: number;
  commits: number;
  reviews: number;
  activeWorks: number;
  deployed: number;
  tokens: number;
  unassignedTokens: number;
  analysisTokens: number;
  tokensByProvider: { codex: number; claude: number };
  businessDays: number;
  baselineRate: number | null;
  currentRate: number | null;
  changePercent: number | null;
  daily: { date: string; deliveries: number; reviews: number; tokens: number; businessDay: boolean }[];
}
export interface SyncStatus {
  running: boolean;
  paused: boolean;
  phase: string;
  lastSync: string | null;
  errors: { source: string; message: string; at: string }[];
  coverageStart: string | null;
  coverageComplete: boolean;
}
export interface Diagnostic {
  source: Source;
  installed: boolean;
  authenticated: boolean;
  version: string;
  message: string;
}
export interface Dashboard {
  workspace: Workspace;
  repositories: Repository[];
  contributions: Contribution[];
  metrics: Metrics;
  previousMetrics: Metrics;
  assessment: Assessment;
  status: SyncStatus;
  period: Period;
  demo: boolean;
}
export interface ImportResult {
  repositories: Repository[];
  contributions: Contribution[];
  tokens: TokenUsage[];
  errors: { source: string; message: string; at: string }[];
  complete: boolean;
  coverageStart: string | null;
}
export interface IntegrationContext {
  config: AppConfig;
  since: string | null;
  repositories: Repository[];
  onProgress: (message: string) => void;
  onBatch?: (result: ImportResult) => void;
  signal?: AbortSignal;
  until?: string;
  completedSteps?: ImportStep[];
  onStep?: (step: ImportStep) => void;
  onWait?: (until: number | null) => void;
  request?: <T>(key: string, fetch: () => Promise<T>) => Promise<T>;
  cacheFile?: <T>(path: string, stamp: string, read: () => Promise<T>) => Promise<T>;
}
export interface Discovery {
  login: string;
  organizations: string[];
}
export interface TheSitchApi {
  getConfig(): Promise<AppConfig>;
  getImportHistory(): Promise<ImportHistory>;
  getMayorRanking(period: Period): Promise<MayorRanking>;
  refreshMayorRanking(period: Period): Promise<MayorRanking>;
  setRankingInterval(hours: number): Promise<void>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  getDashboard(period: Period): Promise<Dashboard>;
  sync(fullHistory?: boolean): Promise<SyncStatus>;
  setPaused(paused: boolean): Promise<SyncStatus>;
  diagnostics(): Promise<Diagnostic[]>;
  discover(): Promise<Discovery>;
  analyze(period: Period): Promise<Assessment>;
  setDemo(enabled: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  exportConfig(): Promise<boolean>;
  importConfig(): Promise<AppConfig | null>;
  groupContributions(ids: string[], groupId: string | null): Promise<void>;
  onStatus(callback: (status: SyncStatus) => void): () => void;
}

export type ImportState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'interrupted'
  | 'failed'
  | 'complete';
export interface ImportStep {
  id: string;
  label: string;
  from: string | null;
  to: string;
  processed: number;
  total: number | null;
  state: ImportState;
  detail?: string;
}
export interface ImportRun {
  id: string;
  source: Source;
  mode: 'history' | 'delta';
  since: string | null;
  until: string;
  startedAt: string;
  finishedAt: string | null;
  state: ImportState;
  phase: string;
  steps: ImportStep[];
  requests: number;
  reusedRequests: number;
  retryAt: string | null;
  errors: string[];
}
export interface ImportSourceHistory {
  source: Source;
  enabled: boolean;
  lastSuccessAt: string | null;
  checkedThrough: string | null;
  historyComplete: boolean;
  run: ImportRun | null;
  recent: ImportRun[];
  stored: { records: number; first: string | null; last: string | null; kinds: Record<string, number> };
}
export interface ImportHistory {
  sources: ImportSourceHistory[];
  syncMinutes: number;
  paused: boolean;
  running: boolean;
  generatedAt: string;
}

export interface MayorRanking {
  period: Period;
  organizations: string[];
  intervalHours: number;
  running: boolean;
  phase: string;
  error: string | null;
  checkedAt: string | null;
  nextAt: string | null;
  completedDays: number;
  totalDays: number;
  repositories: number;
  partial: boolean;
  rows: { login: string; merged: number; rank: number; me: boolean }[];
  mean: number;
  median: number;
  mine: number;
  difference: number | null;
}
