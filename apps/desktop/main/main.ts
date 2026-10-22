import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { redact } from '@gametable/agent';
import { registerIpc } from './ipc.js';

const isDev = process.env.GAMETABLE_DEV === '1';

// Electron picks libsecret or KWallet from the desktop environment. Allow an
// explicit choice for sessions where that guess is wrong (e.g. a KDE desktop
// whose only secret service is gnome-keyring).
const passwordStore = process.env.GAMETABLE_PASSWORD_STORE;
if (passwordStore && /^(gnome-libsecret|kwallet|kwallet5|kwallet6|basic)$/.test(passwordStore)) {
  app.commandLine.appendSwitch('password-store', passwordStore);
}
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

  // Links in chat open in the browser, and only over http(s).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  if (isDev) {
    void window.loadURL('http://localhost:5173');
  } else {
    void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
}

app.whenReady().then(() => {
  // Push-to-talk needs the microphone; nothing else is granted.
  const ownsRequest = (contents: Electron.WebContents | null): boolean =>
    Boolean(mainWindow && contents && contents === mainWindow.webContents);
  const audioOnly = (types?: string[]): boolean =>
    !types || types.every((type) => type === 'audio');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(ownsRequest(contents) && permission === 'media' && audioOnly(types));
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      ownsRequest(contents) && permission === 'media' && details.mediaType !== 'video',
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
  console.error('[main] unhandled rejection', redact(String(reason)).slice(0, 200));
});
