import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { HISTORY_START } from '../shared/defaults';
import type { ImportResult, IntegrationContext } from '../shared/types';
import { errorResult } from './cli';
import { sessionFiles } from './session-files';
import { createRepositoryResolver } from './token-repositories';

type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};
type Row = {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    parent_id?: string;
    source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } };
    model?: string;
    type?: string;
    info?: { total_token_usage?: Usage };
  };
};
function sessionParser(fallbackId: string) {
  let id = fallbackId,
    cwd = '',
    model = '',
    parent = '';
  const events: { timestamp: string; usage: Required<Usage>; cwd: string; model: string }[] = [];
  let previous: Required<Usage> = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  const accept = (line: string) => {
    if (!line.trim()) return;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      return;
    }
    const p = row.payload || {};
    if (row.type === 'session_meta') {
      id = String(p.id || id);
      cwd = String(p.cwd || cwd);
      parent = String(p.parent_id || p.source?.subagent?.thread_spawn?.parent_thread_id || '');
    }
    if (row.type === 'turn_context') {
      cwd = String(p.cwd || cwd);
      model = String(p.model || model);
    }
    if (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.total_token_usage || !row.timestamp)
      return;
    const raw = p.info.total_token_usage as Usage;
    const current: Required<Usage> = {
      input_tokens: Number(raw.input_tokens) || 0,
      cached_input_tokens: Number(raw.cached_input_tokens) || 0,
      output_tokens: Number(raw.output_tokens) || 0,
      total_tokens: Number(raw.total_tokens) || 0,
    };
    const reset =
      current.total_tokens < previous.total_tokens ||
      current.input_tokens < previous.input_tokens ||
      current.output_tokens < previous.output_tokens;
    const base = reset
      ? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      : previous;
    const usage = {
      input_tokens: Math.max(0, current.input_tokens - base.input_tokens),
      cached_input_tokens: Math.max(0, current.cached_input_tokens - base.cached_input_tokens),
      output_tokens: Math.max(0, current.output_tokens - base.output_tokens),
      total_tokens: Math.max(0, current.total_tokens - base.total_tokens),
    };
    previous = current;
    if (usage.total_tokens) events.push({ timestamp: row.timestamp, usage, cwd, model });
  };
  return { accept, result: () => ({ id, cwd, model, parent, events }) };
}
export function parseSession(text: string, fallbackId: string) {
  const parser = sessionParser(fallbackId);
  for (const line of text.split('\n')) parser.accept(line);
  return parser.result();
}
async function parseSessionFile(file: string, signal?: AbortSignal) {
  const parser = sessionParser(file);
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    signal?.throwIfAborted();
    parser.accept(line);
  }
  return parser.result();
}
export async function collectCodex(context: IntegrationContext): Promise<ImportResult> {
  const { config } = context;
  const result: ImportResult = {
    repositories: [],
    contributions: [],
    tokens: [],
    errors: [],
    complete: true,
    coverageStart: null,
  };
  const paths: string[] = [];
  const dirs = [
    config.codexSessionsPath,
    path.join(path.dirname(config.codexSessionsPath), 'archived_sessions'),
  ];
  for (const dir of dirs)
    try {
      paths.push(...(await sessionFiles(dir)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.complete = false;
        result.errors.push(errorResult('codex', e));
      }
    }
  const sessions = new Map<string, Awaited<ReturnType<typeof parseSessionFile>>>();
  let checkedFiles = 0;
  const fileProgress = (detail: string) =>
    context.onStep?.({
      id: 'files',
      label: 'Arquivos locais Codex',
      from: null,
      to: context.until ?? new Date().toISOString(),
      processed: checkedFiles,
      total: paths.length,
      state: checkedFiles === paths.length ? (result.complete ? 'complete' : 'failed') : 'running',
      detail,
    });
  fileProgress('Inventário local; arquivos inalterados são reaproveitados');
  for (const file of paths) {
    context.signal?.throwIfAborted();
    try {
      const info = await stat(file);
      if (!context.cacheFile && context.since && info.mtimeMs < Date.parse(context.since)) continue;
      const session = context.cacheFile
        ? await context.cacheFile(file, `${info.mtimeMs}:${info.size}`, () =>
            parseSessionFile(file, context.signal),
          )
        : await parseSessionFile(file, context.signal);
      if (!sessions.has(session.id)) sessions.set(session.id, session);
    } catch (e) {
      result.complete = false;
      result.errors.push(errorResult('codex', e));
    } finally {
      checkedFiles++;
      fileProgress(path.basename(file));
    }
  }
  let processedSessions = 0;
  const resolveRepository = createRepositoryResolver(context);
  for (const session of sessions.values()) {
    context.signal?.throwIfAborted();
    const before = result.tokens.length;
    const parent = sessions.get(session.parent);
    const parentEvents = new Set(parent?.events.map((e) => JSON.stringify([e.timestamp, e.usage])) || []);
    for (let i = 0; i < session.events.length; i++) {
      const event = session.events[i];
      if (Date.parse(event.timestamp) < Date.parse(HISTORY_START)) continue;
      if (!context.cacheFile && context.since && event.timestamp < context.since) continue;
      if (parentEvents.has(JSON.stringify([event.timestamp, event.usage]))) continue;
      const cwd = event.cwd;
      const isTheSitch = cwd.includes('thesitch-analysis-');
      const repoId = isTheSitch ? null : await resolveRepository(cwd);
      if (repoId === false && !isTheSitch) continue;
      const member = config.workspace.members[0];
      if (!member) continue;
      const u = event.usage;
      result.tokens.push({
        id: `codex:${session.id}:${i}`,
        workspaceId: config.workspace.id,
        memberId: member.id,
        sessionId: session.id,
        repositoryId: repoId || null,
        occurredAt: event.timestamp,
        input: u.input_tokens,
        cached: u.cached_input_tokens,
        output: u.output_tokens,
        total: u.total_tokens,
        model: event.model,
        isTheSitch,
        provider: 'codex',
      });
    }
    context.onBatch?.({ ...result, tokens: result.tokens.slice(before), errors: [], complete: false });
    context.onStep?.({
      id: 'records',
      label: 'Sessões Codex gravadas',
      from: null,
      to: context.until ?? new Date().toISOString(),
      processed: ++processedSessions,
      total: sessions.size,
      state: processedSessions === sessions.size ? 'complete' : 'running',
      detail: `${result.tokens.length} registros de uso conferidos`,
    });
  }
  if (result.complete && result.tokens.length)
    result.coverageStart = result.tokens.reduce(
      (a, t) => (t.occurredAt < a ? t.occurredAt : a),
      result.tokens[0].occurredAt,
    );
  return result;
}
