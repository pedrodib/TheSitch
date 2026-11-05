const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');

// Runs the compiled IPC worker against the real SQLite shipped with Electron, without a WindowServer.
const dir = mkdtempSync(join(tmpdir(), 'thesitch-worker-smoke-'));
const port = new EventEmitter();
const timeout = setTimeout(() => { console.error('Worker smoke timeout'); process.exitCode = 1; finish(); }, 15000);
let completed = false;
function finish() {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  rmSync(dir, { recursive: true, force: true });
}
port.postMessage = (message) => {
  try {
    assert.equal(message.error, undefined, message.error);
    if (message.type === 'ready') port.emit('message', { data: { id: 1, method: 'getConfig', args: [] } });
    if (message.id === 1) {
      assert.equal(message.result.version, 1);
      port.emit('message', { data: { id: 2, method: 'setDemo', args: [true] } });
    }
    if (message.id === 2) {
      const today = new Date().toISOString().slice(0, 10);
      port.emit('message', { data: { id: 3, method: 'getDashboard', args: [{ start: today.slice(0, 8) + '01', end: today }] } });
    }
    if (message.id === 3) {
      assert.equal(message.result.demo, true);
      assert.ok(message.result.repositories.length > 0);
      port.emit('message', { data: { id: 4, method: 'getImportHistory', args: [] } });
    }
    if (message.id === 4) {
      assert.deepEqual(message.result.sources.map(source => source.source).sort(), ['azure', 'bitbucket', 'claude', 'codex', 'github', 'gitlab']);
      assert.ok(message.result.sources.filter(source => ['gitlab', 'bitbucket'].includes(source.source)).every(source => !source.enabled));
      assert.ok(message.result.sources.every(source => source.stored.records === 0));
      const today = new Date().toISOString().slice(0, 10);
      port.emit('message', { data: { id: 5, method: 'getMayorRanking', args: [{start: today, end: today}] } });
    }
    if (message.id === 5) {
      assert.equal(message.result.intervalHours, 2);
      assert.equal(message.result.rows.length, 0);
      port.emit('message', { data: { id: 6, method: 'setRankingInterval', args: [3] } });
    }
    if (message.id === 6) {
      console.log('Compiled worker + Electron SQLite + IPC + import history + mayor ranking: OK');
      finish();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    finish();
  }
};
Object.defineProperty(process, 'parentPort', { value: port });
process.argv[2] = dir;
require(resolve('out/main/worker.js'));
