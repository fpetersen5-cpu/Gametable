import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, TableSnapshot, MatchSummary, Debrief, ArenaProgress } from '../shared/api.js';

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DesktopApi = {
  status: () => ipcRenderer.invoke('app:status'),
  setKey: (key) => ipcRenderer.invoke('key:set', key),
  clearKey: () => ipcRenderer.invoke('key:clear'),
  listModels: (refresh) => ipcRenderer.invoke('models:list', refresh === true),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  listGames: () => ipcRenderer.invoke('games:list'),
  startMatch: (request) => ipcRenderer.invoke('match:start', request),
  submitAction: (action) => ipcRenderer.invoke('match:action', action),
  setPaused: (paused) => ipcRenderer.invoke('match:pause', paused),
  setSpeed: (speed) => ipcRenderer.invoke('match:speed', speed),
  abortMatch: () => ipcRenderer.invoke('match:abort'),
  takeoverSeat: (seatId) => ipcRenderer.invoke('match:takeover', seatId),
  releaseSeat: (seatId) => ipcRenderer.invoke('match:release', seatId),
  onTable: (handler) => subscribe<TableSnapshot>('match:table', handler),
  onFinished: (handler) => subscribe<MatchSummary>('match:finished', handler),
  onMatchError: (handler) => subscribe<string>('match:error', handler),
  onDebrief: (handler) => subscribe<Debrief>('match:debrief', handler),

  listMatches: () => ipcRenderer.invoke('matches:list'),
  listResumable: () => ipcRenderer.invoke('matches:resumable'),
  resumeMatch: (matchId) => ipcRenderer.invoke('match:resume', matchId),
  loadReplay: (matchId) => ipcRenderer.invoke('matches:replay', matchId),
  exportTranscript: (matchId) => ipcRenderer.invoke('matches:export', matchId),
  leaderboard: () => ipcRenderer.invoke('leaderboard'),
  speak: (text, seatId) => ipcRenderer.invoke('tts:speak', { text, seatId }),
  transcribe: (wavBase64) => ipcRenderer.invoke('stt:transcribe', { audio: wavBase64 }),
  arenaStart: (config) => ipcRenderer.invoke('arena:start', config),
  arenaPause: (paused) => ipcRenderer.invoke('arena:pause', paused),
  arenaCancel: () => ipcRenderer.invoke('arena:cancel'),
  arenaState: () => ipcRenderer.invoke('arena:state'),
  onArena: (handler) => subscribe<ArenaProgress>('arena:progress', handler),

  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
};

contextBridge.exposeInMainWorld('gametable', api);
