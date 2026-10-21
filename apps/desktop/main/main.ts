import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { registerIpc } from './ipc.js';

const isDev = process.env.GAMETABLE_DEV === '1';
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0e1116',
    title: 'GameTable',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void window.loadURL('http://localhost:5173');
  } else {
    void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
}

app.whenReady().then(() => {
  // Push-to-talk needs the microphone; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'media',
  );

  registerIpc(app.getPath('userData'), () => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', String(reason).slice(0, 200));
});
