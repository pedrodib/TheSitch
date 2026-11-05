import { contextBridge, ipcRenderer } from 'electron';
import type { SyncStatus, TheSitchApi } from '../shared/types';

const api: TheSitchApi = {
  refreshMayorRanking: (period) => ipcRenderer.invoke('app:refreshMayorRanking', period),
  getMayorRanking: (period) => ipcRenderer.invoke('app:getMayorRanking', period),
  setRankingInterval: (hours) => ipcRenderer.invoke('app:setRankingInterval', hours),
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  getImportHistory: () => ipcRenderer.invoke('app:getImportHistory'),
  saveConfig: (config) => ipcRenderer.invoke('app:saveConfig', config),
  getDashboard: (period) => ipcRenderer.invoke('app:getDashboard', period),
  sync: (fullHistory) => ipcRenderer.invoke('app:sync', fullHistory),
  setPaused: (paused) => ipcRenderer.invoke('app:setPaused', paused),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  discover: () => ipcRenderer.invoke('app:discover'),
  analyze: (period) => ipcRenderer.invoke('app:analyze', period),
  setDemo: (enabled) => ipcRenderer.invoke('app:setDemo', enabled),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  exportConfig: () => ipcRenderer.invoke('app:exportConfig'),
  importConfig: () => ipcRenderer.invoke('app:importConfig'),
  groupContributions: (ids, groupId) => ipcRenderer.invoke('app:groupContributions', ids, groupId),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: SyncStatus) => callback(status);
    ipcRenderer.on('app:status', listener);
    return () => ipcRenderer.removeListener('app:status', listener);
  },
};
contextBridge.exposeInMainWorld('theSitch', api);
