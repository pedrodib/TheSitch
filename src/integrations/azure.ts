import { HISTORY_START } from '../shared/defaults';
import type { ImportResult, IntegrationContext } from '../shared/types';
import { errorResult, run } from './cli';
export async function collectAzure(context: IntegrationContext): Promise<ImportResult> {
  const { config, onProgress } = context;
  const since = context.since && context.since > HISTORY_START ? context.since : HISTORY_START;
  const execute = (args: string[]) =>
    context.request
      ? context.request(JSON.stringify(args), () => run(config.cli.az, args, { signal: context.signal }))
      : run(config.cli.az, args, { signal: context.signal });
  const result: ImportResult = {
    repositories: [],
    contributions: [],
    tokens: [],
    errors: [],
    complete: true,
    coverageStart: null,
  };
  if (!config.azure.enabled) return result;
  try {
    await execute(['extension', 'show', '--name', 'azure-devops', '--output', 'json']);
    let projects = config.azure.projects;
    if (!projects.length) {
      const page = JSON.parse(
        await execute([
          'devops',
          'project',
          'list',
          '--organization',
          config.azure.organization,
          '--top',
          '1000',
          '--output',
          'json',
        ]),
      ) as { value: { name: string }[]; count?: number };
      projects = page.value.map((p) => p.name);
      if (page.value.length >= 1000) throw new Error('Azure project list exceeds supported limit');
    }
    const member = config.workspace.members[0];
    if (!member) return result;
    for (const project of projects)
      context.onStep?.({
        id: project,
        label: `Azure / ${project}`,
        from: since,
        to: context.until ?? new Date().toISOString(),
        processed: 0,
        total: null,
        state: 'pending',
      });
    for (const project of projects) {
      context.signal?.throwIfAborted();
      context.onStep?.({
        id: project,
        label: `Azure / ${project}`,
        from: since,
        to: context.until ?? new Date().toISOString(),
        processed: 0,
        total: null,
        state: 'running',
        detail: 'Descobrindo cards por ID',
      });
      onProgress(`Azure: ${project}`);
      const safeProject = project.replace(/'/g, "''");
      const changed =
        (since ? ` AND [System.ChangedDate] >= '${since.slice(0, 10)}'` : '') +
        (context.until ? ` AND [System.ChangedDate] <= '${context.until}'` : '');
      const rows: { id: number; fields?: Record<string, unknown> }[] = [];
      let cursor = 0;
      // The installed Azure extension silently caps boards query at about 1,000 rows.
      // Stable ID windows recover the rest without relying on an unsupported --top option.
      for (;;) {
        const wiql = `SELECT [System.Id], [System.Title], [System.CreatedDate], [System.ChangedDate], [System.State], [System.WorkItemType] FROM WorkItems WHERE [System.TeamProject] = '${safeProject}' AND [System.AssignedTo] = @Me AND [System.Id] > ${cursor}${changed} ORDER BY [System.Id] ASC`;
        const batch = (JSON.parse(
          await execute([
            'boards',
            'query',
            '--organization',
            config.azure.organization,
            '--project',
            project,
            '--wiql',
            wiql,
            '--output',
            'json',
          ]),
        ) ?? []) as typeof rows;
        if (!Array.isArray(batch)) throw new Error('Formato de cards Azure inesperado.');
        rows.push(...batch);
        if (batch.length < 1000) break;
        const next = Math.max(...batch.map((item) => item.id));
        if (!Number.isSafeInteger(next) || next <= cursor || rows.length >= 100000)
          throw new Error('Consulta Azure excedeu o limite seguro de importação.');
        cursor = next;
      }
      let processed = 0;
      for (const item of rows) {
        context.signal?.throwIfAborted();
        const f = item.fields || {};
        if (!f['System.Title']) {
          result.complete = false;
          result.errors.push(errorResult('azure', new Error('Azure work item details were unavailable')));
          continue;
        }
        const org = config.azure.organization.replace(/\/$/, '').toLowerCase();
        const id = `azure:${org}:${project.toLowerCase()}:${item.id}`;
        const workState = String(f['System.State'] || '').toLowerCase();
        result.contributions.push({
          id,
          workspaceId: config.workspace.id,
          memberId: member.id,
          repositoryId: '',
          source: 'azure',
          externalId: `${org}/${project.toLowerCase()}/${item.id}`,
          kind: 'work_item',
          title: String(f['System.Title']),
          body: '',
          url: `${config.azure.organization.replace(/\/$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`,
          occurredAt: String(f['System.CreatedDate'] || ''),
          updatedAt: String(f['System.ChangedDate'] || ''),
          state: /^(done|closed|resolved|completed)$/.test(workState) ? 'closed' : 'building',
          additions: 0,
          deletions: 0,
          linkedWorkItem: `azure:${org}:${item.id}`,
          participants: [member.id],
          labels: [String(f['System.WorkItemType'] || '')].filter(Boolean),
        });
        context.onBatch?.({
          ...result,
          contributions: [result.contributions[result.contributions.length - 1]],
          errors: [],
          complete: false,
        });
        context.onStep?.({
          id: project,
          label: `Azure / ${project}`,
          from: since,
          to: context.until ?? new Date().toISOString(),
          processed: ++processed,
          total: rows.length,
          state: processed === rows.length ? 'complete' : 'running',
        });
      }
      if (!rows.length)
        context.onStep?.({
          id: project,
          label: `Azure / ${project}`,
          from: since,
          to: context.until ?? new Date().toISOString(),
          processed: 0,
          total: 0,
          state: 'complete',
        });
    }
    if (result.complete && !since && result.contributions.length)
      result.coverageStart = result.contributions.reduce(
        (a, c) => (c.occurredAt < a ? c.occurredAt : a),
        result.contributions[0].occurredAt,
      );
  } catch (e) {
    result.complete = false;
    result.errors.push(errorResult('azure', e));
  }
  return result;
}
