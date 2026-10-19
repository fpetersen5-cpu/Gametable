import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/api.js';

const api: DesktopApi = {
  status: () => ipcRenderer.invoke('app:status'),
  setKey: (key) => ipcRenderer.invoke('key:set', key),
  clearKey: () => ipcRenderer.invoke('key:clear'),
  listModels: (refresh) => ipcRenderer.invoke('models:list', refresh === true),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
};

contextBridge.exposeInMainWorld('gametable', api);
