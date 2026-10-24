import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buckshot } from '@gametable/games-buckshot';
import { ResultsStore } from '@gametable/stats';
import { DemoClient } from './demo.js';
import { MatchSession } from './session.js';
import type { MatchEvent, Seat } from '@gametable/engine';
import type { StartMatchRequest, TableSnapshot } from '../shared/api.js';

interface Saved {
  matchId: string;
  state: unknown;
  events: MatchEvent[];
  controllers?: Record<string, unknown>;
}

describe('resumable seat memory', () => {
  it('carries seat spend and notes into a resumed session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-session-'));
    const seats: Seat[] = [
      { id: 's1', name: 'Atlas', kind: 'llm', modelId: 'demo/atlas-4' },
      { id: 's2', name: 'Marlowe', kind: 'llm', modelId: 'demo/marlowe' },
    ];
    const request: StartMatchRequest = {
      gameId: buckshot.id,
      seats: seats.map((seat) => ({ name: seat.name, kind: 'llm', modelId: seat.modelId })),
      budgetUsd: 5,
      speed: 8,
    };
    const store = new ResultsStore(join(dir, 'results.jsonl'));
    let latest: Saved | null = null;

    const session = new MatchSession({
      def: buckshot,
      seats,
      request,
      client: new DemoClient(),
      store,
      saveBundle: async () => undefined,
      send: () => undefined,
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: () => undefined,
      sendDebrief: () => undefined,
      debriefModel: null,
      saveLive: async (snapshot) => {
        latest = snapshot as Saved;
      },
    });
    void session.start();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const controllers = (latest as Saved | null)?.controllers ?? {};
      const states = Object.values(controllers) as Array<{ notes?: string; costUsd?: number }>;
      if (states.length === 2 && states.every((state) => (state.notes ?? '').length > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    session.abortMatch();

    const saved = latest as Saved | null;
    expect(saved).not.toBeNull();
    const savedStates = Object.values(saved?.controllers ?? {}) as Array<{
      notes?: string;
      costUsd?: number;
    }>;
    expect(savedStates).toHaveLength(2);
    expect(savedStates.every((state) => (state.notes ?? '').length > 0)).toBe(true);
    const spent = savedStates.reduce((sum, state) => sum + (state.costUsd ?? 0), 0);
    expect(spent).toBeGreaterThan(0);

    let firstSnapshot: TableSnapshot | null = null;
    const resumed = new MatchSession({
      def: buckshot,
      seats,
      request,
      client: new DemoClient(),
      store,
      saveBundle: async () => undefined,
      send: (snapshot) => {
        firstSnapshot ??= snapshot;
      },
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: () => undefined,
      sendDebrief: () => undefined,
      debriefModel: null,
      resume: {
        state: saved?.state,
        events: saved?.events ?? [],
        controllers: saved?.controllers ?? {},
      },
    });
    void resumed.start();

    const resumeDeadline = Date.now() + 5_000;
    while (!firstSnapshot && Date.now() < resumeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    resumed.abortMatch();

    expect(firstSnapshot).not.toBeNull();
    const snapshot = firstSnapshot as unknown as TableSnapshot | null;
    expect(snapshot?.costUsd ?? 0).toBeCloseTo(spent, 6);
  }, 25_000);
});
