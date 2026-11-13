import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
  dialog: {},
  safeStorage: {},
  shell: {},
}));
import { registerIpc } from './ipc.js';

describe('model memory IPC', () => {
  let dir: string;
  const contents = { send: vi.fn() };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const invoke = (name: string, ...args: unknown[]) =>
    mocks.handlers.get(name)!({ sender: contents }, ...args);
  const seed = async (models: Array<{ key: string; memory: string; updatedAt: number }>) => {
    await writeFile(join(dir, 'model-memory.json'), JSON.stringify({ version: 1, models }));
    registerIpc(dir, () => window);
  };

  beforeEach(async () => {
    mocks.handlers.clear();
    dir = await mkdtemp(join(tmpdir(), 'gt-memory-ipc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists and clears per-model memory', async () => {
    await seed([
      { key: 'openrouter:one/model', memory: 'one notes', updatedAt: 2 },
      { key: 'openrouter:two/model', memory: 'two notes', updatedAt: 1 },
    ]);

    const listed = (await invoke('memory:list')) as Array<{ key: string; memory: string }>;
    expect(listed.map((entry) => entry.key)).toEqual([
      'openrouter:one/model',
      'openrouter:two/model',
    ]);

    await invoke('memory:clear', 'openrouter:one/model');
    const remaining = (await invoke('memory:list')) as Array<{ key: string }>;
    expect(remaining.map((entry) => entry.key)).toEqual(['openrouter:two/model']);

    await invoke('memory:clear');
    expect(await invoke('memory:list')).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'model-memory.json'), 'utf8')).models).toEqual([]);
  });

  it('rejects a non-string memory key', async () => {
    await seed([]);
    await expect(invoke('memory:clear', 42)).rejects.toThrow(/memory key/);
  });
});
