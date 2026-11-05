import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ startSync: vi.fn(async () => ({})) }));
vi.mock('../src/main/service', () => ({
  AppService: class {
    startSync = service.startSync;
  },
}));

it('passes a full-history request from IPC to the collector service', async () => {
  const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const previousArg = process.argv[2];
  const previousListeners = new Set(process.listeners('SIGTERM'));
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  Object.defineProperty(process, 'parentPort', { value: port, configurable: true });
  process.argv[2] = '/tmp/thesitch-worker-test';
  try {
    await import('../src/main/worker');
    port.emit('message', { data: { id: 1, method: 'sync', args: [true] } });
    await Promise.resolve();
    expect(service.startSync).toHaveBeenCalledWith(true);
  } finally {
    if (previousPort) Object.defineProperty(process, 'parentPort', previousPort);
    else Reflect.deleteProperty(process, 'parentPort');
    process.argv[2] = previousArg;
    for (const listener of process.listeners('SIGTERM'))
      if (!previousListeners.has(listener)) process.removeListener('SIGTERM', listener);
  }
});
