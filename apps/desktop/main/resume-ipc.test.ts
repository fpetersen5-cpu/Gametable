import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import type { GameDef, MatchEvent, Seat } from '@gametable/engine';
import { buckshot } from '@gametable/games-buckshot';
import { coup } from '@gametable/games-coup';
import { mafia } from '@gametable/games-mafia';
import { firstLegalAction } from '@gametable/sdk-conformance';
import { DEFAULT_CONFIG, type StartMatchRequest, type TableSnapshot } from '../shared/api.js';

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
import { SecretStore } from './secrets.js';
import { MatchSession } from './session.js';
import * as secureFiles from './secure-file.js';

describe('resuming a saved match through IPC', () => {
  let dir: string;

  beforeEach(async () => {
    mocks.handlers.clear();
    dir = await mkdtemp(join(tmpdir(), 'gt-resume-ipc-'));
    await mkdir(join(dir, 'live'));
    vi.spyOn(SecretStore.prototype, 'getKey').mockResolvedValue('sk-or-test-resume');
    vi.spyOn(Math, 'random').mockReturnValue(0.987654321);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  for (const def of [buckshot, coup, mafia] as GameDef<any>[]) {
    for (const actionCount of [0, 4]) {
      it(`preserves ${def.name}'s full state after ${actionCount} actions, including seed zero`, async () => {
        const seed = 0;
        const seats: Seat[] = Array.from({ length: def.minSeats }, (_, index) => ({
          id: `s${index + 1}`,
          name: `Seat ${index + 1}`,
          kind: index === 0 ? 'human' : 'llm',
          ...(index === 0 ? {} : { modelId: 'fake/model' }),
        }));
        // Normal UI requests omit a seed; the generated seed is saved separately.
        const request: StartMatchRequest = {
          gameId: def.id,
          seats: seats.map((seat) => ({
            name: seat.name,
            kind: seat.kind === 'human' ? 'human' : 'llm',
            ...(seat.modelId ? { modelId: seat.modelId } : {}),
          })),
          budgetUsd: 1,
          speed: 8,
        };
        let state = def.setup({ seed, seats, options: { trackOptimality: false, discussionRounds: 1 } });
        const events: MatchEvent[] = [];
        for (let seq = 0; seq < actionCount; seq++) {
          const phase = def.phase(state);
          const seatId = phase.actor ?? phase.actors[0]!;
          const action = def.view(state, seatId).legalActions[0]!;
          state = def.apply(state, seatId, action);
          events.push({ seq, phaseId: phase.id, round: phase.round, seatId, action, at: seq });
        }
        const matchId = 'm-resume-seed';
        await writeFile(join(dir, 'live', `${matchId}.json`), JSON.stringify({
          matchId, gameId: def.id, request, seats, seed, state, events,
        }));

        const expectedView = def.view(state, 's1');
        // Observe the reconstructed engine state, including secrets and RNG state.
        const godView = vi.spyOn(def, 'godView');
        const snapshots: TableSnapshot[] = [];
        const errors: string[] = [];
        const contents = {
          send: (channel: string, payload: any) => {
            if (channel === 'match:error') errors.push(payload);
            if (channel !== 'match:table') return;
            snapshots.push(payload);
            // Stop before any real model call can start.
            if (payload.status === 'running') void invoke('match:abort');
          },
        };
        const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
        const invoke = (name: string, ...args: unknown[]) =>
          mocks.handlers.get(name)!({ sender: contents }, ...args);
        registerIpc(dir, () => window);

        expect(await invoke('match:resume', matchId)).toEqual({ ok: true, matchId });
        expect(errors).toEqual([]);
        expect(snapshots[0]?.view).toEqual(expectedView);
        expect(snapshots[0]?.eventCount).toBe(actionCount);
        expect(godView.mock.calls.at(-1)?.[0]).toEqual(state);
      });
    }
  }

  it('refuses a live file whose saved state does not match its event log', async () => {
    const seats: Seat[] = [
      { id: 's1', name: 'You', kind: 'human' },
      { id: 's2', name: 'Model', kind: 'llm', modelId: 'fake/model' },
    ];
    const request: StartMatchRequest = {
      gameId: buckshot.id,
      seats: seats.map((seat) => ({
        name: seat.name,
        kind: seat.kind === 'human' ? 'human' : 'llm',
        ...(seat.modelId ? { modelId: seat.modelId } : {}),
      })),
      budgetUsd: 1,
      speed: 8,
    };
    const seed = 0;
    const state = buckshot.setup({ seed, seats, options: {} });
    const mismatched = structuredClone(state) as typeof state;
    mismatched.hp = [99, 99];
    const matchId = 'm-resume-mismatch';
    await writeFile(join(dir, 'live', `${matchId}.json`), JSON.stringify({
      matchId, gameId: buckshot.id, request, seats, seed, state: mismatched, events: [],
    }));

    const errors: string[] = [];
    const contents = {
      send: (channel: string, payload: any) => {
        if (channel === 'match:error') errors.push(payload);
      },
    };
    const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    registerIpc(dir, () => window);
    const invoke = (name: string, ...args: unknown[]) =>
      mocks.handlers.get(name)!({ sender: contents }, ...args);

    expect(await invoke('match:resume', matchId)).toEqual({ ok: true, matchId });
    await vi.waitFor(() => expect(errors.length).toBe(1));
    expect(errors[0]).toMatch(/does not match/);
  });
});

describe('model routing when starting and resuming matches', () => {
  let dir: string;
  const key = 'sk-or-test-routing';
  const cloudUrl = 'https://openrouter.ai/api/v1/chat/completions';
  const localUrl = 'http://127.0.0.1:12345/v1';
  const otherLocalUrl = 'http://127.0.0.1:23456/v1';
  const calls: Array<{ url: string; model: string; authorization?: string; debrief: boolean }> = [];

  beforeEach(async () => {
    mocks.handlers.clear();
    calls.length = 0;
    dir = await mkdtemp(join(tmpdir(), 'gt-routing-ipc-'));
    await mkdir(join(dir, 'live'));
    vi.spyOn(SecretStore.prototype, 'getKey').mockResolvedValue(null);
    // Routing tests exercise real sessions and HTTP clients; persistence is covered separately.
    vi.spyOn(secureFiles, 'secureWrite').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://openrouter.ai/api/v1/auth/key') {
        return Response.json({ data: { limit: 5, usage: 0 } });
      }
      const body = JSON.parse(String(init?.body));
      const schema = body.response_format?.json_schema?.schema;
      calls.push({
        url,
        model: body.model,
        authorization: (init?.headers as Record<string, string>)?.Authorization,
        debrief: !schema,
      });
      return Response.json({
        model: body.model,
        choices: [{ message: { content: schema
          ? JSON.stringify({ action: firstLegalAction(schema, 'Test'), notes: 'Test' })
          : 'Test debrief' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
      });
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    hasKey: boolean;
    seats: StartMatchRequest['seats'];
    routes: Array<{ url: string; model: string }>;
    debriefModel: string | null;
  }> = [
    {
      name: 'local seats with the same model on different saved endpoints, without a key',
      hasKey: false,
      seats: [
        { name: 'Local A', kind: 'llm', modelId: 'local/model', provider: 'local', baseUrl: localUrl },
        { name: 'Local B', kind: 'llm', modelId: 'local/model', provider: 'local', baseUrl: otherLocalUrl },
      ],
      routes: [localUrl, otherLocalUrl].map((url) => ({ url: `${url}/chat/completions`, model: 'local/model' })),
      debriefModel: null,
    },
    {
      name: 'local-only seats on the default endpoint, even with a saved cloud key',
      hasKey: true,
      seats: [
        { name: 'Local A', kind: 'llm', modelId: 'local/a', provider: 'local' },
        { name: 'Local B', kind: 'llm', modelId: 'local/b', provider: 'local' },
      ],
      routes: ['local/a', 'local/b'].map((model) => ({ url: `${DEFAULT_CONFIG.localEndpoint}/chat/completions`, model })),
      debriefModel: null,
    },
    {
      name: 'mixed seats, including a legacy cloud seat without an explicit provider',
      hasKey: true,
      seats: [
        { name: 'Local', kind: 'llm', modelId: 'local/model', provider: 'local', baseUrl: localUrl },
        { name: 'Cloud', kind: 'llm', modelId: 'cloud/model' },
      ],
      routes: [
        { url: `${localUrl}/chat/completions`, model: 'local/model' },
        { url: cloudUrl, model: 'cloud/model' },
      ],
      debriefModel: 'cloud/model',
    },
    {
      name: 'zero-budget seats without making any model calls',
      hasKey: false,
      seats: ['A', 'B'].map(name => ({
        name, kind: 'llm', modelId: 'local/model', provider: 'local', baseUrl: localUrl, budgetUsd: 0,
      })),
      routes: [],
      debriefModel: null,
    },
  ];

  it('retries a failed replay save through IPC only for the open match', async () => {
    vi.mocked(secureFiles.secureWrite).mockImplementation(async (file) => {
      if (file.includes('/matches/')) throw new Error('disk full');
    });
    let latest: TableSnapshot | undefined;
    const contents = { send: (channel: string, payload: TableSnapshot) => {
      if (channel === 'match:table') latest = payload;
    } };
    const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    registerIpc(dir, () => window);
    const start = MatchSession.prototype.start;
    let running: Promise<void> | undefined;
    vi.spyOn(MatchSession.prototype, 'start').mockImplementation(function (this: MatchSession) {
      running = start.call(this);
      return running;
    });
    const invoke = (channel: string, payload: unknown) => mocks.handlers.get(channel)!({ sender: contents }, payload);
    const result = await invoke('match:start', {
      gameId: coup.id, seed: 42, speed: 8, budgetUsd: 1, seats: cases[0]!.seats,
    }) as { ok: boolean; matchId: string };
    expect(result.ok).toBe(true);
    await running;
    expect(latest?.saveState?.status).toBe('error');
    const modelCalls = calls.length;
    expect(await invoke('match:retry-save', 'm-another-match')).toMatchObject({ ok: false });
    expect(() => mocks.handlers.get('match:retry-save')!({ sender: {} }, result.matchId)).toThrow('untrusted IPC sender');
    vi.mocked(secureFiles.secureWrite).mockResolvedValue(undefined);
    expect(await invoke('match:retry-save', result.matchId)).toEqual({ ok: true });
    expect(latest?.saveState?.status).toBe('saved');
    expect(calls).toHaveLength(modelCalls);
    expect((await readFile(join(dir, 'results.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  for (const mode of ['start', 'resume'] as const) {
    for (const scenario of cases) {
      it(`${mode}: routes ${scenario.name}`, async () => {
        vi.mocked(SecretStore.prototype.getKey).mockResolvedValue(scenario.hasKey ? key : null);
        const request: StartMatchRequest = {
          gameId: coup.id, seed: 42, speed: 8, budgetUsd: 1, seats: scenario.seats,
        };
        const seats: Seat[] = request.seats.map((seat, index) => ({
          id: `s${index + 1}`, name: seat.name, kind: seat.kind, modelId: seat.modelId,
          ...(seat.budgetUsd === undefined ? {} : { budgetUsd: seat.budgetUsd }),
        }));
        const matchId = 'm-provider-resume';
        await writeFile(join(dir, 'live', `${matchId}.json`), JSON.stringify({
          matchId, gameId: coup.id, request, seats, seed: 42, events: [],
          state: coup.setup({ seed: 42, seats, options: {} }),
        }));
        const messages: Array<{ channel: string; payload: any }> = [];
        const contents = { send: (channel: string, payload: any) => messages.push({ channel, payload }) };
        const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
        registerIpc(dir, () => window);
        const start = MatchSession.prototype.start;
        let running: Promise<void> | undefined;
        vi.spyOn(MatchSession.prototype, 'start').mockImplementation(function (this: MatchSession) {
          running = start.call(this);
          return running;
        });

        const result = await mocks.handlers.get(`match:${mode}`)!({ sender: contents }, mode === 'start' ? request : matchId);
        expect(result).toMatchObject({ ok: true });
        await running;
        expect(messages.filter((entry) => entry.channel === 'match:error')).toEqual([]);
        expect(messages.find((entry) => entry.channel === 'match:finished')?.payload).toMatchObject({
          debriefExpected: scenario.debriefModel !== null,
        });
        if (scenario.debriefModel) {
          await vi.waitFor(() => expect(messages.some((entry) => entry.channel === 'match:debrief')).toBe(true));
        }
        const moves = calls.filter((call) => !call.debrief);
        for (const route of scenario.routes) expect(moves).toContainEqual(expect.objectContaining(route));
        for (const call of moves) {
          expect(scenario.routes).toContainEqual({ url: call.url, model: call.model });
          expect(call.authorization).toBe(call.url === cloudUrl ? `Bearer ${key}` : undefined);
        }
        expect(calls.filter((call) => call.debrief)).toEqual(scenario.debriefModel ? [{
          url: cloudUrl, model: scenario.debriefModel, authorization: `Bearer ${key}`, debrief: true,
        }] : []);
      });
    }

    it(`${mode}: requires a key when a mixed table contains a cloud seat`, async () => {
      const request: StartMatchRequest = {
        gameId: coup.id, seed: 42, speed: 8, budgetUsd: 1,
        seats: [
          { name: 'Local', kind: 'llm', modelId: 'local/model', provider: 'local', baseUrl: localUrl },
          { name: 'Cloud', kind: 'llm', modelId: 'cloud/model', provider: 'openrouter' },
        ],
      };
      const seats: Seat[] = request.seats.map((seat, index) => ({
        id: `s${index + 1}`, name: seat.name, kind: seat.kind, modelId: seat.modelId,
      }));
      const matchId = 'm-missing-key';
      await writeFile(join(dir, 'live', `${matchId}.json`), JSON.stringify({
        matchId, gameId: coup.id, request, seats, seed: 42, events: [],
        state: coup.setup({ seed: 42, seats, options: {} }),
      }));
      const contents = { send: vi.fn() };
      const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
      registerIpc(dir, () => window);

      expect(await mocks.handlers.get(`match:${mode}`)!({ sender: contents }, mode === 'start' ? request : matchId))
        .toEqual({ ok: false, error: 'Add an OpenRouter key first' });
      expect(fetch).not.toHaveBeenCalled();
      expect(contents.send).not.toHaveBeenCalled();
    });
  }
});
