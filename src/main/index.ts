import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  shell,
  Tray,
  utilityProcess,
} from 'electron';
import type { AppConfig, SyncStatus } from '../shared/types';
import { validateConfig, validatePeriod } from '../shared/validation';
import { trayIconData } from './tray-icon';

if (process.env.THESITCH_DATA_DIR) app.setPath('userData', process.env.THESITCH_DATA_DIR);
let window: BrowserWindow | null = null;
let worker: Electron.UtilityProcess | null = null;
let tray: Tray | null = null;
let quitting = false;
let counter = 0;
let workerReady: Promise<void>;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  await workerReady;
  if (!worker) throw new Error('Serviço local indisponível. Reinicie o TheSitch.');
  return new Promise<T>((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('A operação demorou mais que o esperado. Confira o estado das integrações.'));
    }, 12 * 60_000);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    worker?.postMessage({ id, method, args });
  });
}

function startWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('O banco local não iniciou a tempo.')), 20000);
    worker = utilityProcess.fork(join(__dirname, 'worker.js'), [app.getPath('userData')], {
      serviceName: 'TheSitch · Arquivo Municipal',
      stdio: 'pipe',
    });
    worker.stdout?.on('data', () => {
      /* CLI output is deliberately not forwarded to application logs. */
    });
    worker.stderr?.on('data', () => {
      /* Sensitive CLI output stays out of logs. */
    });
    worker.on(
      'message',
      (message: { type?: string; id?: number; result?: unknown; error?: string; status?: SyncStatus }) => {
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (message.type === 'status') {
          window?.webContents.send('app:status', message.status);
          return;
        }
        if (message.id === undefined) return;
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      },
    );
    worker.on('exit', () => {
      clearTimeout(timer);
      worker = null;
      const error = new Error('O serviço local encerrou. Reinicie o app; seus dados foram preservados.');
      reject(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    });
  });
}

function showWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1000,
    minHeight: 720,
    title: `TheSitch ${app.getVersion()} · Neon City`,
    backgroundColor: '#f4f0e7',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  const handle = (name: string, handler: (...args: unknown[]) => unknown) =>
    ipcMain.handle(`app:${name}`, (event, ...args: unknown[]) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Origem não autorizada.');
      return handler(...args);
    });
  handle('getConfig', () => call('getConfig'));
  handle('saveConfig', async (value) => {
    const config = await call<AppConfig>('saveConfig', validateConfig(value));
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
    void call('sync').catch(() => {});
    return config;
  });
  handle('refreshMayorRanking', (period) => call('refreshMayorRanking', validatePeriod(period)));
  handle('getMayorRanking', (period) => call('getMayorRanking', validatePeriod(period)));
  handle('setRankingInterval', (hours) => call('setRankingInterval', hours));
  handle('getImportHistory', () => call('getImportHistory'));
  handle('getDashboard', (period) => call('getDashboard', validatePeriod(period)));
  handle('analyze', (period) => call('analyze', validatePeriod(period)));
  handle('sync', (fullHistory) => {
    if (fullHistory !== undefined && typeof fullHistory !== 'boolean')
      throw new Error('Importação inválida.');
    return call('sync', fullHistory === true);
  });
  handle('setPaused', (value) => {
    if (typeof value !== 'boolean') throw new Error('Estado inválido.');
    return call('setPaused', value);
  });
  handle('setDemo', (value) => {
    if (typeof value !== 'boolean') throw new Error('Estado inválido.');
    return call('setDemo', value);
  });
  handle('diagnostics', () => call('diagnostics'));
  handle('discover', () => call('discover'));
  handle('groupContributions', (ids, groupId) => {
    if (
      !Array.isArray(ids) ||
      ids.length > 1000 ||
      !ids.every((id) => typeof id === 'string' && id.length < 1000) ||
      (groupId !== null && (typeof groupId !== 'string' || groupId.length > 1000))
    )
      throw new Error('Agrupamento inválido.');
    return call('groupContributions', ids, groupId);
  });
  handle('openExternal', async (value) => {
    if (typeof value !== 'string' || value.length > 4000) throw new Error('Link inválido.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Apenas links HTTPS são permitidos.');
    await shell.openExternal(url.toString());
  });
  handle('exportConfig', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Exportar configuração (sem credenciais)',
      defaultPath: 'thesitch.config.json',
      filters: [{ name: 'Configuração JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const config = await call<AppConfig>('getConfig');
    await writeFile(result.filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return true;
  });
  handle('importConfig', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importar configuração',
      properties: ['openFile'],
      filters: [{ name: 'Configuração JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const data = await readFile(result.filePaths[0], 'utf8');
    if (data.length > 1_000_000) throw new Error('Arquivo de configuração muito grande.');
    const config = validateConfig(JSON.parse(data));
    return call('saveConfig', config);
  });
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(trayIconData).resize({ width: 22, height: 22 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('TheSitch · Neon City');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir TheSitch', click: showWindow },
      {
        label: 'Sincronizar agora',
        click: () => {
          void call('sync').catch(() => showWindow());
        },
      },
      {
        label: 'Pausar sincronização',
        type: 'checkbox',
        click: (item) => {
          void call('setPaused', item.checked).catch(() => showWindow());
        },
      },
      { type: 'separator' },
      { label: 'Sair do TheSitch', accelerator: 'Command+Q', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  void app.whenReady().then(async () => {
    app.setAppUserModelId('app.thesitch.desktop');
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'TheSitch',
          submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    registerIpc();
    workerReady = startWorker();
    createTray();
    showWindow();
    try {
      await workerReady;
      void call('sync').catch(() => {});
    } catch {
      dialog.showErrorBox(
        'Arquivo municipal indisponível',
        'Não foi possível iniciar o serviço local. Feche e abra o app novamente.',
      );
    }
    powerMonitor.on('resume', () => {
      void call('sync').catch(() => {});
    });
  });
}
app.on('activate', () => {
  if (app.isReady()) showWindow();
});
app.on('before-quit', () => {
  quitting = true;
  worker?.kill();
  tray?.destroy();
});
app.on('window-all-closed', () => {
  /* The menu bar owns the application's lifetime. */
});
