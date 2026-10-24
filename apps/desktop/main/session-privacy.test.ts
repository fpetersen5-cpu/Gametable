import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coup } from '@gametable/games-coup';
import { FakeModelClient } from '@gametable/sdk-conformance';
import { ResultsStore } from '@gametable/stats';
import type { Seat } from '@gametable/engine';
import type { TableSnapshot } from '../shared/api.js';
import { MatchSession } from './session.js';

describe('live IPC projection', () => {
  for (const spectator of [false, true]) {
    it(`${spectator ? 'allows spectator' : 'blocks player'} access to god views`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gt-privacy-'));
      const seats: Seat[] = [
        { id: 's1', name: 'One', kind: spectator ? 'llm' : 'human', modelId: 'fake/one' },
        { id: 's2', name: 'Two', kind: 'llm', modelId: 'fake/two' },
      ];
      const snapshots: TableSnapshot[] = [];
      const session = new MatchSession({
        def: coup, seats, request: {
          gameId: coup.id, budgetUsd: 1, seed: 1, speed: 8,
          seats: seats.map((seat) => ({ ...seat, kind: seat.kind === 'human' ? 'human' : 'llm' })),
        },
        client: new FakeModelClient(), store: new ResultsStore(join(dir, 'results.jsonl')),
        saveBundle: async () => undefined,
        send: (snapshot) => snapshots.push(structuredClone(snapshot)),
        sendPreview: () => undefined, sendFinished: () => undefined,
        sendError: () => undefined, sendDebrief: () => undefined, debriefModel: null,
      });
      session.setPaused(true);
      const running = session.start();
      try {
        expect(snapshots.length).toBeGreaterThan(0);
        const first = snapshots[0]!;
        expect(first.spectator).toBe(spectator);
        if (spectator) {
          expect(first.godView?.seatId).toBe('__all__');
        } else {
          expect(first.view.seatId).toBe('s1');
          for (const snapshot of snapshots) expect(snapshot.godView).toBeNull();
          expect(JSON.stringify(first)).not.toContain('"hands"');
          expect(JSON.stringify(first)).not.toContain('"deck"');
        }
      } finally {
        session.abortMatch();
        session.setPaused(false);
        await running;
      }
      if (!spectator) for (const snapshot of snapshots) expect(snapshot.godView).toBeNull();
    });
  }
});
