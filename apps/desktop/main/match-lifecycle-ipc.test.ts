import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { StartMatchRequest, StartMatchResult } from '../shared/api.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<any>>(),
  sessions: [] as Array<{ matchId: string; deps: any; abortMatch: ReturnType<typeof vi.fn> }>,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: any) => mocks.handlers.set(name, fn) },
  dialog: {}, safeStorage: {}, shell: {},
}));
vi.mock('./session.js', () => ({ MatchSession: class {
  matchId = `m-test-${mocks.sessions.length}`;
  abortMatch = vi.fn(() => {
    this.deps.send({ matchId: this.matchId, status: 'aborted' });
    queueMicrotask(() => this.deps.send({ matchId: this.matchId, status: 'aborted' }));
  });
  constructor(readonly deps: any) { mocks.sessions.push(this); }
  async start() { this.deps.send({ matchId: this.matchId, status: 'running' }); }
} }));
import { registerIpc } from './ipc.js';
import { ModelCatalogCache } from './catalog.js';
import { SecretStore } from './secrets.js';

let dir: string;
const contents = { send: vi.fn() };
const request: StartMatchRequest = {
  gameId: 'coup', budgetUsd: 1, speed: 8,
  seats: ['A', 'B'].map(name => ({ name, kind: 'llm', modelId: 'test/local', provider: 'local' })),
};
const invoke = (name: string, ...args: unknown[]) => mocks.handlers.get(name)!({ sender: contents }, ...args);
const launch = (kind: 'start' | 'resume') => invoke(`match:${kind}`, kind === 'start' ? request : 'm-saved');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gt-lifecycle-'));
  await mkdir(join(dir, 'live'));
  await writeFile(join(dir, 'live/m-saved.json'), JSON.stringify({
    matchId: 'm-saved', gameId: request.gameId, request, seed: 42, state: {}, events: [],
    seats: request.seats.map((seat, i) => ({ ...seat, id: `s${i + 1}` })),
  }));
  mocks.sessions.length = 0;
  contents.send.mockClear();
  vi.spyOn(SecretStore.prototype, 'getKey').mockResolvedValue(null);
  registerIpc(dir, () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

it.each([
  ['start', 'start'], ['start', 'resume'], ['resume', 'start'], ['resume', 'resume'],
] as const)('a pending %s is superseded by a newer %s', async (first, second) => {
  let release!: () => void;
  const pending = new Promise<null>(resolve => { release = () => resolve(null); });
  const read = vi.spyOn(ModelCatalogCache.prototype, 'read').mockResolvedValue(null);
  read.mockReturnValueOnce(pending);
  const older = launch(first);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const newer = await launch(second) as StartMatchResult;
  release();
  expect(await older).toMatchObject({ ok: false });
  expect(newer.ok).toBe(true);
  expect(mocks.sessions).toHaveLength(1);
});

it.each(['start', 'resume'] as const)('aborting during asynchronous %s cancels the launch', async (kind) => {
  let release!: () => void;
  const read = vi.spyOn(ModelCatalogCache.prototype, 'read').mockImplementation(() => new Promise(resolve => { release = () => resolve(null); }));
  const pendingLaunch = launch(kind);
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await invoke('match:abort');
  release();
  expect(await pendingLaunch).toMatchObject({ ok: false });
  expect(mocks.sessions).toHaveLength(0);
});

it.each(['start', 'resume'] as const)('late messages from a replaced %s cannot overwrite the new table', async (kind) => {
  await launch(kind);
  const previous = mocks.sessions[0]!;
  const result = await invoke('match:start', request);
  await Promise.resolve();
  contents.send.mockClear();
  previous.deps.send({ matchId: previous.matchId, status: 'aborted' });
  previous.deps.sendError('late failure');
  previous.deps.sendFinished({ matchId: previous.matchId });
  previous.deps.sendPreview('s1', 'old reply');
  previous.deps.sendDebrief({ matchId: previous.matchId, text: 'old debrief' });
  expect(previous.abortMatch).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(true);
  expect(contents.send).not.toHaveBeenCalled();
});
