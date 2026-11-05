import { homedir } from 'node:os';
import { AppService } from './service';

const port = process.parentPort;
if (!port) throw new Error('TheSitch worker must run as an Electron utility process.');
const dataDir = process.argv[2];
if (!dataDir) throw new Error('Missing application data directory.');
const service = new AppService(dataDir, homedir(), (status) => port.postMessage({ type: 'status', status }));
port.on('message', async ({ data }: { data: { id: number; method: string; args: unknown[] } }) => {
  try {
    const methods: Record<string, (...args: unknown[]) => unknown> = {
      refreshMayorRanking: (period) => service.refreshMayorRanking(period),
      getMayorRanking: (period) => service.getMayorRanking(period),
      setRankingInterval: (hours) => service.setRankingInterval(hours),
      getConfig: () => service.getConfig(),
      getImportHistory: () => service.getImportHistory(),
      saveConfig: (value) => service.saveConfig(value),
      getDashboard: (value) => service.getDashboard(value),
      sync: (fullHistory) => service.startSync(fullHistory === true),
      setPaused: (value) => service.setPaused(value as boolean),
      setDemo: (value) => service.setDemo(value as boolean),
      diagnostics: () => service.diagnostics(),
      discover: () => service.discover(),
      analyze: (value) => service.analyze(value),
      groupContributions: (ids, group) => service.groupContributions(ids as string[], group as string | null),
    };
    const handler = methods[data.method];
    if (!handler) throw new Error('Operação desconhecida.');
    const result = await handler(...data.args);
    port.postMessage({ id: data.id, result });
  } catch (error) {
    port.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : 'Falha na operação local.',
    });
  }
});
port.postMessage({ type: 'ready' });
process.on('SIGTERM', () => {
  service.close();
  process.exit(0);
});
