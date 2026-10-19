import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { registerIpc } from './ipc.js';

const isDev = process.env.GAMETABLE_DEV === '1';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'GameTable',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

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
  registerIpc(app.getPath('userData'));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The renderer never needs the key; keep it out of crash reports too.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', String(reason).slice(0, 200));
});
