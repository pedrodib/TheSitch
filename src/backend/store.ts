import { copyFileSync, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { repositoryInScope } from '../shared/repositories';
import type {
  AppConfig,
  Assessment,
  Contribution,
  ImportResult,
  Repository,
  SyncStatus,
  TokenUsage,
} from '../shared/types';
import { createDemoData } from './demo';

const initialStatus: SyncStatus = {
  running: false,
  paused: false,
  phase: 'Aguardando sincronização',
  lastSync: null,
  errors: [],
  coverageStart: null,
  coverageComplete: false,
};

/** Local, workspace-scoped persistence. Demo records never enter the database. */
export class Store {
  private db: DatabaseSync;
  private config: AppConfig;

  constructor(dbPath: string, initialConfig: AppConfig) {
    // Preserve the original before changing an existing schema.
    if (dbPath !== ':memory:' && existsSync(dbPath) && statSync(dbPath).size > 0) {
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      const version = (probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      probe.close();
      if (version < 1) {
        copyFileSync(dbPath, `${dbPath}.backup`);
        for (const suffix of ['-wal', '-shm'])
          if (existsSync(`${dbPath}${suffix}`))
            copyFileSync(`${dbPath}${suffix}`, `${dbPath}.backup${suffix}`);
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id));
      CREATE TABLE IF NOT EXISTS contributions (workspace TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id), UNIQUE(workspace,source,external_id,kind));
      CREATE TABLE IF NOT EXISTS tokens (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace,id));
      CREATE TABLE IF NOT EXISTS state (workspace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace,key));
      PRAGMA user_version = 1;`);
    const saved = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('config') as
      | { value: string }
      | undefined;
    this.config = saved ? { ...initialConfig, ...(JSON.parse(saved.value) as AppConfig) } : initialConfig;
    if (!saved) this.saveConfig(initialConfig);
    const status = this.getStatus();
    if (status.running) this.setStatus({ ...status, running: false, phase: 'Interrompido' });
  }
  getConfig(): AppConfig {
    return structuredClone(this.config);
  }
  saveConfig(config: AppConfig): AppConfig {
    const scope = (value: AppConfig) =>
      JSON.stringify({
        organizations: [...value.organizations].map((s) => s.trim().toLowerCase()).sort(),
        host: value.githubHost.toLowerCase(),
        members: value.workspace.members.map((m) => m.externalLogin.toLowerCase()).sort(),
        azure: value.azure,
        gitlab: value.gitlab,
        bitbucket: value.bitbucket,
      });
    const scopeChanged =
      this.config && this.config.workspace.id === config.workspace.id && scope(this.config) !== scope(config);
    if (scopeChanged) {
      this.db
        .prepare(
          "DELETE FROM state WHERE workspace=? AND (key IN ('checkpoint:github', 'checkpoint:gitlab', 'checkpoint:bitbucket', 'checkpoint:azure', 'checkpoint:codex', 'checkpoint:claude') OR key LIKE 'analysis:%' OR key LIKE 'import:%')",
        )
        .run(config.workspace.id);
      const status = this.getStatus();
      this.setStatus({ ...status, coverageComplete: false, coverageStart: null, lastSync: null });
    }
    if (
      this.config &&
      this.config.workspace.id === config.workspace.id &&
      JSON.stringify([
        this.config.codexSessionsPath,
        this.config.claudeSessionsPath,
        this.config.repoMappings,
      ]) !== JSON.stringify([config.codexSessionsPath, config.claudeSessionsPath, config.repoMappings])
    ) {
      this.db
        .prepare(
          "DELETE FROM state WHERE workspace=? AND (key IN ('checkpoint:codex', 'checkpoint:claude') OR key LIKE 'import:codex:%' OR key LIKE 'import:claude:%')",
        )
        .run(config.workspace.id);
    }
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('config', JSON.stringify(config));
    this.config = structuredClone(config);
    return this.getConfig();
  }
  private rows<T>(table: 'repositories' | 'contributions' | 'tokens'): T[] {
    return (
      this.db
        .prepare(`SELECT data FROM ${table} WHERE workspace = ? ORDER BY id`)
        .all(this.config.workspace.id) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as T);
  }
  getRepositories(demo = false): Repository[] {
    if (demo) return createDemoData(this.config).repositories;
    return this.rows<Repository>('repositories').filter((repo) => repositoryInScope(repo, this.config));
  }
  getContributions(demo = false): Contribution[] {
    if (demo) return createDemoData(this.config).contributions;
    const ids = new Set(this.getRepositories().map((repo) => repo.id));
    return this.rows<Contribution>('contributions').filter((item) => {
      if (['github', 'gitlab', 'bitbucket'].includes(item.source)) return ids.has(item.repositoryId);
      if (item.source === 'azure') {
        if (!this.config.azure.enabled) return false;
        const root = this.config.azure.organization.replace(/\/$/, '');
        return this.config.azure.projects.length
          ? this.config.azure.projects.some((project) =>
              item.url.startsWith(`${root}/${encodeURIComponent(project)}/_workitems/`),
            )
          : item.url.startsWith(`${root}/`);
      }
      return true;
    });
  }
  getTokens(demo = false): TokenUsage[] {
    if (demo) return createDemoData(this.config).tokens;
    const ids = new Set(this.getRepositories().map((repo) => repo.id));
    return this.rows<TokenUsage>('tokens').filter((item) => !item.repositoryId || ids.has(item.repositoryId));
  }
  importResult(result: ImportResult, workspace = this.config.workspace.id): void {
    const repo = this.db.prepare(
      'INSERT INTO repositories(workspace,id,data) VALUES (?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET data=excluded.data WHERE data != excluded.data',
    );
    const contribution = this.db.prepare(
      'INSERT INTO contributions(workspace,id,source,external_id,kind,data) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace,source,external_id,kind) DO UPDATE SET data=excluded.data WHERE data != excluded.data',
    );
    const token = this.db.prepare(
      'INSERT INTO tokens(workspace,id,data) VALUES (?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET data=excluded.data WHERE data != excluded.data',
    );
    const previousToken = this.db.prepare('SELECT data FROM tokens WHERE workspace=? AND id=?');
    this.transaction(() => {
      for (const item of result.repositories)
        if (item.workspaceId === workspace) repo.run(workspace, item.id, JSON.stringify(item));
      for (const item of result.contributions)
        if (item.workspaceId === workspace) {
          const existing = this.db
            .prepare(
              'SELECT data FROM contributions WHERE workspace=? AND source=? AND external_id=? AND kind=?',
            )
            .get(workspace, item.source, item.externalId, item.kind) as { data: string } | undefined;
          const previous = existing ? (JSON.parse(existing.data) as Contribution) : undefined;
          // Preserve local grouping and stable identity when an integration refreshes a record.
          const merged = previous
            ? {
                ...item,
                id: previous.id,
                memberId: previous.memberId,
                groupId: previous.groupId,
                participants: [
                  ...new Set([
                    ...previous.participants,
                    previous.memberId,
                    ...item.participants,
                    item.memberId,
                  ]),
                ],
              }
            : item;
          contribution.run(
            workspace,
            merged.id,
            merged.source,
            merged.externalId,
            merged.kind,
            JSON.stringify(merged),
          );
        }
      for (const item of result.tokens) {
        if (item.workspaceId !== workspace) continue;
        let merged = item;
        if (item.provider === 'claude') {
          const row = previousToken.get(workspace, item.id) as { data: string } | undefined;
          const previous = row ? (JSON.parse(row.data) as TokenUsage) : undefined;
          if (previous && previous.total > item.total)
            merged = {
              ...item,
              input: previous.input,
              output: previous.output,
              cached: previous.cached,
              cacheWrite: previous.cacheWrite,
              total: previous.total,
              occurredAt: previous.occurredAt,
            };
        }
        token.run(workspace, merged.id, JSON.stringify(merged));
      }
    });
  }
  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getState<T>(key: string): T | null {
    const row = this.db
      .prepare('SELECT value FROM state WHERE workspace=? AND key=?')
      .get(this.config.workspace.id, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO state(workspace,key,value) VALUES (?,?,?) ON CONFLICT(workspace,key) DO UPDATE SET value=excluded.value',
      )
      .run(this.config.workspace.id, key, JSON.stringify(value));
  }
  deleteStatePrefix(prefix: string): void {
    this.db
      .prepare('DELETE FROM state WHERE workspace=? AND substr(key,1,?)=?')
      .run(this.config.workspace.id, prefix.length, prefix);
  }
  getCheckpoint(source: string): string | null {
    return this.getState(`checkpoint:${source}`);
  }
  setCheckpoint(source: string, checkpoint: string): void {
    this.setState(`checkpoint:${source}`, checkpoint);
  }
  getStatus(): SyncStatus {
    return this.getState<SyncStatus>('status') ?? structuredClone(initialStatus);
  }
  setStatus(status: SyncStatus): void {
    this.setState('status', status);
  }
  getAnalysis(key: string): Assessment | null {
    return this.getState(`analysis:${key}`);
  }
  setAnalysis(key: string, assessment: Assessment): void {
    this.setState(`analysis:${key}`, assessment);
  }
  groupContributions(ids: string[], groupId: string | null): void {
    const select = this.db.prepare('SELECT data FROM contributions WHERE workspace=? AND id=?');
    const update = this.db.prepare('UPDATE contributions SET data=? WHERE workspace=? AND id=?');
    this.transaction(() => {
      for (const id of ids) {
        const row = select.get(this.config.workspace.id, id) as { data: string } | undefined;
        if (row) {
          const item = JSON.parse(row.data) as Contribution;
          item.groupId = groupId;
          update.run(JSON.stringify(item), this.config.workspace.id, id);
        }
      }
    });
  }
  close(): void {
    this.db.close();
  }
}
