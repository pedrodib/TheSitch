import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { HISTORY_START } from '../shared/defaults';
import type { ImportResult, IntegrationContext } from '../shared/types';
import { errorResult } from './cli';
import { sessionFiles } from './session-files';
import { createRepositoryResolver } from './token-repositories';

type ClaudeEvent = {
  id: string;
  timestamp: string;
  cwd: string;
  sessionId: string;
  model: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  total: number;
};

/** Reads usage metadata only; content blocks and prompts never enter the token records. */
export function parseClaudeUsage(line: string): ClaudeEvent | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row?.type !== 'assistant' || !row.message || typeof row.message !== 'object') return null;
  const message = row.message as Record<string, unknown>;
  if (!message.usage || typeof message.usage !== 'object') return null;
  const usage = message.usage as Record<string, unknown>;
  const values = [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens',
  ].map((field) => usage[field] ?? 0);
  if (!values.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
    return null;
  const [uncached, cached, cacheWrite, output] = values as number[];
  const input = uncached + cached + cacheWrite;
  const total = input + output;
  if (!total || !Number.isSafeInteger(total)) return null;
  const identity =
    typeof message.id === 'string' && message.id
      ? `message:${message.id}`
      : typeof row.requestId === 'string' && row.requestId
        ? `request:${row.requestId}`
        : typeof row.uuid === 'string' && row.uuid
          ? `event:${row.uuid}`
          : '';
  if (!identity || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)))
    return null;
  return {
    id: `claude:${createHash('sha256').update(identity).digest('hex')}`,
    timestamp: new Date(row.timestamp).toISOString(),
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    sessionId:
      typeof row.sessionId === 'string'
        ? row.sessionId
        : typeof row.session_id === 'string'
          ? row.session_id
          : '',
    model: typeof message.model === 'string' ? message.model : '',
    input,
    cached,
    cacheWrite,
    output,
    total,
  };
}

/** Imports primary and subagent transcripts with stable IDs across copies and resynchronizations. */
export async function collectClaude(context: IntegrationContext): Promise<ImportResult> {
  const { config } = context;
  const result: ImportResult = {
    repositories: [],
    contributions: [],
    tokens: [],
    errors: [],
    complete: true,
    coverageStart: null,
  };
  const events = new Map<string, ClaudeEvent>();
  let paths: string[];
  try {
    paths = await sessionFiles(config.claudeSessionsPath ?? path.join(os.homedir(), '.claude/projects'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.complete = false;
      result.errors.push(errorResult('claude', error));
    }
    return result;
  }
  let checkedFiles = 0;
  context.onStep?.({
    id: 'files',
    label: 'Arquivos locais Claude Code',
    from: null,
    to: context.until ?? new Date().toISOString(),
    processed: 0,
    total: paths.length,
    state: 'running',
  });
  for (const file of paths.sort()) {
    context.signal?.throwIfAborted();
    try {
      const info = await stat(file);
      if (!context.cacheFile && context.since && info.mtimeMs < Date.parse(context.since)) continue;
      const read = async () => {
        const collected: ClaudeEvent[] = [];
        const lines = createInterface({
          input: createReadStream(file, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          context.signal?.throwIfAborted();
          const event = parseClaudeUsage(line);
          if (event) collected.push(event);
        }
        return collected;
      };
      const rows = context.cacheFile
        ? await context.cacheFile(file, `${info.mtimeMs}:${info.size}`, read)
        : await read();
      for (const event of rows) {
        const previous = events.get(event.id);
        if (!previous || event.total >= previous.total)
          events.set(event.id, {
            ...event,
            timestamp:
              previous && previous.timestamp < event.timestamp ? previous.timestamp : event.timestamp,
          });
      }
    } catch (error) {
      result.complete = false;
      result.errors.push(errorResult('claude', error));
    } finally {
      checkedFiles++;
      context.onStep?.({
        id: 'files',
        label: 'Arquivos locais Claude Code',
        from: null,
        to: context.until ?? new Date().toISOString(),
        processed: checkedFiles,
        total: paths.length,
        state: checkedFiles === paths.length && result.complete ? 'complete' : 'running',
        detail: path.basename(file),
      });
    }
  }
  const resolveRepository = createRepositoryResolver(context);
  const member = config.workspace.members[0];
  if (!member) return result;
  let published = 0;
  for (const event of events.values()) {
    context.signal?.throwIfAborted();
    if (Date.parse(event.timestamp) < Date.parse(HISTORY_START)) continue;
    if (!context.cacheFile && context.since && event.timestamp < context.since) continue;
    const repositoryId = await resolveRepository(event.cwd);
    if (repositoryId === false) continue;
    result.tokens.push({
      id: event.id,
      workspaceId: config.workspace.id,
      memberId: member.id,
      sessionId: event.sessionId,
      repositoryId,
      occurredAt: event.timestamp,
      input: event.input,
      output: event.output,
      cached: event.cached,
      cacheWrite: event.cacheWrite,
      total: event.total,
      model: event.model,
      provider: 'claude',
      isTheSitch: false,
    });
    if (result.tokens.length - published >= 500) {
      context.onBatch?.({ ...result, tokens: result.tokens.slice(published), errors: [], complete: false });
      published = result.tokens.length;
      context.onStep?.({
        id: 'records',
        label: 'Uso Claude Code gravado',
        from: null,
        to: context.until ?? new Date().toISOString(),
        processed: published,
        total: null,
        state: 'running',
        detail: 'Deduplicando respostas e associando repositórios',
      });
    }
  }
  context.onBatch?.({ ...result, tokens: result.tokens.slice(published), errors: [], complete: false });
  context.onStep?.({
    id: 'records',
    label: 'Uso Claude Code gravado',
    from: null,
    to: context.until ?? new Date().toISOString(),
    processed: result.tokens.length,
    total: result.tokens.length,
    state: result.complete ? 'complete' : 'failed',
  });
  if (result.tokens.length)
    result.coverageStart = result.tokens.reduce(
      (first, item) => (item.occurredAt < first ? item.occurredAt : first),
      result.tokens[0].occurredAt,
    );
  return result;
}
