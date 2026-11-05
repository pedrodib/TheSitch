import { beforeEach, expect, it, vi } from 'vitest';
import { collectAzure } from '../src/integrations/azure';
import { run } from '../src/integrations/cli';
import { defaultConfig } from '../src/shared/defaults';

vi.mock('../src/integrations/cli', () => ({
  run: vi.fn(),
  errorResult: (source: string, error: Error) => ({ source, message: error.message, at: '' }),
}));
const command = vi.mocked(run);
const context = () => {
  const config = defaultConfig('/example');
  config.azure = { enabled: true, organization: 'https://dev.azure.com/company', projects: [] };
  return { config, since: null, repositories: [], onProgress: () => {} };
};
const card = (id: number) => ({
  id,
  fields: {
    'System.Title': `Card ${id}`,
    'System.CreatedDate': '2026-10-01T12:00:00Z',
    'System.ChangedDate': '2026-10-05T12:00:00Z',
    'System.State': 'Closed',
    'System.WorkItemType': 'Bug',
  },
});
beforeEach(() => {
  command.mockReset();
});
it('discovers projects and queries the authenticated Azure identity with supported arguments', async () => {
  command.mockImplementation(async (_bin, args) => {
    if (args[0] === 'extension') return '{}';
    if (args[0] === 'devops') return JSON.stringify({ value: [{ name: 'Portal' }] });
    return JSON.stringify([card(123)]);
  });
  const result = await collectAzure(context());
  expect(result.complete).toBe(true);
  expect(result.contributions[0]).toMatchObject({
    title: 'Card 123',
    state: 'closed',
    linkedWorkItem: 'azure:https://dev.azure.com/company:123',
  });
  const query = command.mock.calls.find((call) => call[1][0] === 'boards')?.[1];
  expect(query).toContain('Portal');
  expect(query).not.toContain('--top');
  expect(query?.join(' ')).toContain('[System.AssignedTo] = @Me');
});
it('recovers rows beyond the Azure CLI cap and accepts an empty null response', async () => {
  let requests = 0;
  command.mockImplementation(async (_bin, args) => {
    if (args[0] === 'extension') return '{}';
    if (args[0] === 'devops') return JSON.stringify({ value: [{ name: 'Portal' }] });
    requests += 1;
    return requests === 1 ? JSON.stringify(Array.from({ length: 1000 }, (_, i) => card(i + 1))) : 'null';
  });
  const result = await collectAzure(context());
  expect(result.complete).toBe(true);
  expect(result.contributions).toHaveLength(1000);
  expect(requests).toBe(2);
  expect(command.mock.calls.at(-1)?.[1].join(' ')).toContain('[System.Id] > 1000');
});
