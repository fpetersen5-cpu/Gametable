import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { coup } from '@gametable/games-coup';
import { replayFixture } from './test-fixtures/replay.js';
import type { ExportResult, ReplayBundle } from '../shared/api.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<ExportResult>>(),
  save: vi.fn(), confirm: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<ExportResult>) => mocks.handlers.set(name, handler) },
  dialog: { showSaveDialog: mocks.save, showMessageBox: mocks.confirm },
  safeStorage: {}, shell: {},
}));
import { registerIpc } from './ipc.js';

describe('transcript IPC consent boundary', () => {
  let dir: string;
  let output: string;
  let bundle: ReplayBundle;
  const contents = { send: vi.fn() };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const invoke = (perspective?: unknown) => mocks.handlers.get('matches:export')!(
    { sender: contents }, 'm-privacy-123', perspective,
  );

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.save.mockReset();
    mocks.confirm.mockReset();
    dir = await mkdtemp(join(tmpdir(), 'gt-transcript-'));
    output = join(dir, 'export.md');
    await mkdir(join(dir, 'matches'));
    bundle = replayFixture(coup, 2).bundle();
    bundle.summary.seats[1]!.role = 'SECRET-SUMMARY-ROLE-6421';
    await writeFile(join(dir, 'matches', 'm-privacy-123.json'), JSON.stringify(bundle));
    mocks.save.mockResolvedValue({ canceled: false, filePath: output });
    mocks.confirm.mockResolvedValue({ response: 0 });
    registerIpc(dir, () => window);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('defaults IPC callers to public output without a private-data prompt', async () => {
    expect((await invoke()).ok).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    const markdown = await readFile(output, 'utf8');
    expect(markdown).toContain('Perspective: Public only');
    expect(markdown).not.toContain('SECRET-SUMMARY-ROLE-6421');
  });

  for (const perspective of [{ mode: 'omniscient' }, { mode: 'seat', seatId: 's1' }]) {
    it(`requires native consent before writing a ${perspective.mode} export`, async () => {
      expect(await invoke(perspective)).toEqual({ ok: false, error: 'cancelled' });
      expect(mocks.confirm).toHaveBeenCalledWith(window, expect.objectContaining({
        type: 'warning', defaultId: 0, cancelId: 0,
      }));
      expect(mocks.save).not.toHaveBeenCalled();
      await expect(readFile(output)).rejects.toThrow();
    });
  }

  it('allows a clearly labelled omniscient export only after confirmation', async () => {
    mocks.confirm.mockResolvedValue({ response: 1 });
    expect((await invoke({ mode: 'omniscient' })).ok).toBe(true);
    const markdown = await readFile(output, 'utf8');
    expect(markdown).toContain('WARNING: FULL PRIVATE RECORD');
    expect(markdown).toContain('SECRET-SUMMARY-ROLE-6421');
  });

  it('refuses invalid modes or unknown seats before opening a file dialog', async () => {
    for (const perspective of ['omniscient', { mode: 'god' }, { mode: 'seat', seatId: 'ghost' }]) {
      expect((await invoke(perspective)).ok).toBe(false);
    }
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('refuses incompatible projections without exporting the stored god record', async () => {
    bundle.godViews.at(-1)!.data = { canary: 'PRIVATE-GOD-FALLBACK-8271' };
    await writeFile(join(dir, 'matches', 'm-privacy-123.json'), JSON.stringify(bundle));
    const result = await invoke();
    expect(result.ok).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toThrow();
  });

  it('rejects an untrusted caller before consent or file dialogs', () => {
    expect(() => mocks.handlers.get('matches:export')!({ sender: {} }, 'm-privacy-123', { mode: 'omniscient' }))
      .toThrow('untrusted IPC sender');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
