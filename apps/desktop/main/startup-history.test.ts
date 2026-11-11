import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { OpenRouterClient } from '@gametable/agent';
import { ResultsStore, type MatchRecord } from '@gametable/stats';
import { coup } from '@gametable/games-coup';
import { mafia } from '@gametable/games-mafia';
import { DEFAULT_CONFIG, type LeaderboardRow } from '../shared/api.js';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
  dialog: {}, safeStorage: {}, shell: {},
}));
import { registerIpc } from './ipc.js';
import { SecretStore } from './secrets.js';

describe('startup and history IPC', () => {
  let dir: string;
  const contents = {};
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: contents }, ...args);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gt-history-'));
    handlers.clear();
    vi.spyOn(SecretStore.prototype, 'getKey').mockResolvedValue(null);
    vi.spyOn(SecretStore.prototype, 'storageKind').mockResolvedValue('file');
    registerIpc(dir, () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with defaults when settings are absent and validates older partial settings', async () => {
    expect(await invoke('config:load')).toEqual(DEFAULT_CONFIG);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ humanName: 'Ada' }));
    expect(await invoke('config:load')).toEqual({ ...DEFAULT_CONFIG, humanName: 'Ada' });
  });

  for (const raw of ['{broken', '{"seats":null}', '{"speed":-1}', 'null']) {
    it(`reports invalid settings instead of hanging or silently replacing them: ${raw}`, async () => {
      await writeFile(join(dir, 'config.json'), raw);
      await expect(invoke('config:load')).rejects.toThrow('config.json');
      await writeFile(join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG));
      expect(await invoke('config:load')).toEqual(DEFAULT_CONFIG);
    });
  }

  it('keeps local mode available when the saved key cannot be checked', async () => {
    vi.mocked(SecretStore.prototype.getKey).mockResolvedValue('sk-or-test');
    vi.spyOn(OpenRouterClient.prototype, 'checkKey').mockRejectedValue(new DOMException('deadline', 'TimeoutError'));
    expect(await invoke('app:status')).toMatchObject({ hasKey: true, keyValid: false, storage: 'file' });
  });

  for (const [channel, folder] of [['matches:list', 'matches'], ['matches:resumable', 'live']] as const) {
    it(`distinguishes missing history from an unreadable ${folder} directory`, async () => {
      expect(await invoke(channel)).toEqual([]);
      await writeFile(join(dir, folder), 'not a directory');
      await expect(invoke(channel)).rejects.toMatchObject({ code: 'ENOTDIR' });
    });
  }

  it('returns every resumable match newest first while skipping a corrupt file', async () => {
    await mkdir(join(dir, 'live'));
    for (const updatedAt of [10, 30, 20]) {
      await writeFile(join(dir, 'live', `m-${updatedAt}.json`), JSON.stringify({
        matchId: `m-${updatedAt}`, gameId: coup.id, gameName: coup.name, updatedAt,
        events: [{}], request: { seats: [{ name: `Player ${updatedAt}` }] },
      }));
    }
    await writeFile(join(dir, 'live', 'broken.json'), '{');
    expect(await invoke('matches:resumable')).toMatchObject([
      { matchId: 'm-30', eventCount: 1, seats: [{ name: 'Player 30' }] },
      { matchId: 'm-20' }, { matchId: 'm-10' },
    ]);
  });

  it('recalculates ratings, counts and costs using only the selected game', async () => {
    const record = (gameId: string, winner: string, costUsd: number): MatchRecord => ({
      matchId: `m-${gameId}`, gameId, gameVersion: '1', engineVersion: '1',
      seed: 0, startedAt: 1, durationMs: 1,
      seats: ['a', 'b'].map((id) => ({
        seatId: id, name: id, kind: 'llm', modelId: `model/${id}`, tokensIn: 1, tokensOut: 1,
        costUsd, latencyMs: 1, invalidActions: 0, fallbacks: 0,
      })), winnerSeats: [winner], scores: {}, metrics: {},
    });
    await new ResultsStore(join(dir, 'results.jsonl')).appendMany([
      record(coup.id, 'a', 0.01), record(mafia.id, 'b', 0.5),
    ]);
    const all = await invoke('leaderboard') as LeaderboardRow[];
    expect(all.every((row) => row.matches === 2)).toBe(true);
    const filtered = await invoke('leaderboard', coup.id) as LeaderboardRow[];
    expect(filtered[0]).toMatchObject({ modelId: 'model/a', matches: 1, wins: 1, avgCostUsd: 0.01 });
    expect(filtered[0]!.rating).toBeGreaterThan(all.find((row) => row.modelId === 'model/a')!.rating);
    expect((await invoke('leaderboard', mafia.id) as LeaderboardRow[])[0]?.modelId).toBe('model/b');
    await expect(invoke('leaderboard', 'missing')).rejects.toThrow('Unknown game');
  });
});
