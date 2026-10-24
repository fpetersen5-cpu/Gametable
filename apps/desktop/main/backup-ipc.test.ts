import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { DEFAULT_CONFIG } from '../shared/api.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  save: vi.fn(),
  open: vi.fn(),
  message: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
  dialog: {
    showSaveDialog: mocks.save,
    showOpenDialog: mocks.open,
    showMessageBox: mocks.message,
  },
  safeStorage: {},
  shell: {},
}));
import { registerIpc } from './ipc.js';

describe('backup IPC', () => {
  let dir: string;
  const contents = { send: vi.fn() };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const invoke = (name: string) => mocks.handlers.get(name)!({ sender: contents });

  beforeEach(async () => {
    mocks.handlers.clear();
    dir = await mkdtemp(join(tmpdir(), 'gt-backup-ipc-'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, humanName: 'Tester' }));
    mocks.save.mockResolvedValue({ canceled: false, filePath: join(dir, 'backup.json') });
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [join(dir, 'backup.json')] });
    mocks.message.mockResolvedValue({ response: 2 });
    registerIpc(dir, () => window);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('exports settings/results/replays without credentials and restores them', async () => {
    const exported = await invoke('data:export');
    expect(exported).toMatchObject({ ok: true });
    const backup = JSON.parse(await readFile(join(dir, 'backup.json'), 'utf8'));
    expect(backup).toMatchObject({ format: 'gametable-backup', formatVersion: 1 });
    expect(backup.config.humanName).toBe('Tester');
    expect(JSON.stringify(backup)).not.toContain('apiKey');
    await rm(join(dir, 'config.json'), { force: true });
    const restored = await invoke('data:import');
    expect(restored).toMatchObject({ ok: true, configRestored: true });
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).humanName).toBe('Tester');
  });
});
