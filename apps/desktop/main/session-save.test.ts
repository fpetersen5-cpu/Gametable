import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coup } from '@gametable/games-coup';
import { FakeModelClient } from '@gametable/sdk-conformance';
import { ResultsStore } from '@gametable/stats';
import type { TableSnapshot } from '../shared/api.js';
import { secureWrite } from './secure-file.js';
import { MatchSession, type SessionDeps } from './session.js';

describe('durable match completion', () => {
  let dir: string;
  let store: ResultsStore;
  let latest: TableSnapshot;
  let client: FakeModelClient;
  const errors: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gt-save-'));
    store = new ResultsStore(join(dir, 'results.jsonl'));
    client = new FakeModelClient();
    errors.length = 0;
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  function create(overrides: Partial<SessionDeps> = {}) {
    const seats = [
      { id: 's1', name: 'One', kind: 'llm' as const, modelId: 'test/one' },
      { id: 's2', name: 'Two', kind: 'llm' as const, modelId: 'test/two' },
    ];
    return new MatchSession({
      def: coup, seats, matchId: 'm-save-test',
      request: { gameId: coup.id, seed: 42, speed: 8, budgetUsd: 5, seats },
      client, store,
      saveBundle: async (bundle) => secureWrite(join(dir, 'replay.json'), JSON.stringify(bundle)),
      saveLive: async (snapshot) => secureWrite(join(dir, 'live.json'), JSON.stringify(snapshot)),
      clearLive: async () => rm(join(dir, 'live.json'), { force: true }),
      send: (snapshot) => { latest = snapshot; },
      sendPreview: () => undefined, sendFinished: () => undefined,
      sendError: (message) => errors.push(message), sendDebrief: () => undefined, debriefModel: null, pacing: false,
      ...overrides,
    });
  }

  for (const failure of ['result', 'replay', 'cleanup']) {
    it(`preserves recovery data after ${failure} failure and retries without duplicate results`, async () => {
      let failing = true;
      const append = store.append.bind(store);
      vi.spyOn(store, 'append').mockImplementation(async (record) => {
        if (failure === 'result' && failing) throw new Error('disk full');
        await append(record);
      });
      const saveBundle = vi.fn<SessionDeps['saveBundle']>(async (bundle) => {
        if (failure === 'replay' && failing) throw new Error('disk full');
        await secureWrite(join(dir, 'replay.json'), JSON.stringify(bundle));
      });
      const clearLive = vi.fn(async () => {
        if (failure === 'cleanup' && failing) throw new Error('permission denied');
        await rm(join(dir, 'live.json'), { force: true });
      });
      const session = create({ saveBundle, clearLive });
      await session.start();
      expect(latest.status).toBe('finished');
      expect(latest.saveState?.status).toBe('error');
      const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
      expect(saved.events).toHaveLength(latest.eventCount);
      expect(coup.terminal(saved.state)).toBe(true);
      if (failure !== 'cleanup') expect(clearLive).not.toHaveBeenCalled();
      const callsBeforeRetry = client.calls;
      failing = false;
      const retries = await Promise.all([session.retrySave(), session.retrySave(), session.retrySave()]);
      expect(retries).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      expect(latest.saveState?.status).toBe('saved');
      expect(await store.all()).toHaveLength(1);
      expect(JSON.parse(await readFile(join(dir, 'replay.json'), 'utf8')).summary.matchId).toBe('m-save-test');
      await expect(readFile(join(dir, 'live.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(client.calls).toBe(callsBeforeRetry);
    });
  }

  it('waits for queued autosaves before deleting the recovery file', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const savedCounts: number[] = [];
    const saveLive = vi.fn<NonNullable<SessionDeps['saveLive']>>(async (snapshot) => {
      if (savedCounts.length === 0) await blocked;
      savedCounts.push(snapshot.events.length);
      await secureWrite(join(dir, 'live.json'), JSON.stringify(snapshot));
    });
    const saveBundle = vi.fn<SessionDeps['saveBundle']>(async () => undefined);
    const clearLive = vi.fn(async () => rm(join(dir, 'live.json'), { force: true }));
    const session = create({ saveLive, saveBundle, clearLive });
    const running = session.start();
    try {
      await vi.waitFor(() => expect(latest.status).toBe('finished'), { interval: 5 });
      expect(saveBundle).not.toHaveBeenCalled();
      expect(clearLive).not.toHaveBeenCalled();
    } finally {
      release();
      await running;
    }
    expect(savedCounts[0]).toBe(0);
    expect(savedCounts).toEqual([...savedCounts].sort((a, b) => a - b));
    expect(savedCounts.at(-1)).toBe(latest.eventCount);
    expect(clearLive).toHaveBeenCalledTimes(1);
    await expect(readFile(join(dir, 'live.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a finished match after restart without playing again or duplicating its result', async () => {
    await create({ saveBundle: async () => { throw new Error('disk full'); } }).start();
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
    expect(await store.all()).toHaveLength(1);
    const resumedClient = new FakeModelClient();
    await create({
      client: resumedClient, store: new ResultsStore(join(dir, 'results.jsonl')),
      request: saved.request, seats: saved.seats,
      resume: { seed: saved.seed, spentUsd: saved.spentUsd, state: saved.state, events: saved.events, controllers: saved.controllers },
    }).start();
    expect(resumedClient.calls).toBe(0);
    expect(await store.all()).toHaveLength(1);
    expect(latest.saveState?.status).toBe('saved');
    await expect(readFile(join(dir, 'live.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an autosave error and continues saving newer recovery snapshots', async () => {
    const saveLive = vi.fn<NonNullable<SessionDeps['saveLive']>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (snapshot) => secureWrite(join(dir, 'live.json'), JSON.stringify(snapshot)));
    await create({ saveLive }).start();
    expect(errors).toEqual(['Could not save recovery data. Check available disk space.']);
    expect(latest.saveState?.status).toBe('saved');
    expect(saveLive.mock.calls.length).toBeGreaterThan(1);
  });
});
