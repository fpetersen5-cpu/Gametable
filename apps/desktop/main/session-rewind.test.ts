import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionRequest, CompletionResult } from '@gametable/agent';
import type { MatchEvent, Seat } from '@gametable/engine';
import { coup } from '@gametable/games-coup';
import { ResultsStore } from '@gametable/stats';
import { MatchSession } from './session.js';
import type { TableSnapshot } from '../shared/api.js';

describe('rewind controller memory', () => {
  it('does not carry notes from a rewound turn into the next prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-rewind-'));
    const seats: Seat[] = [
      { id: 's1', name: 'One', kind: 'llm', modelId: 'local/model' },
      { id: 's2', name: 'Two', kind: 'llm', modelId: 'local/model' },
    ];
    const calls: Array<{ seat: string; note: string; prompt: string }> = [];
    const counts = new Map<string, number>();
    const clients = new Map(seats.map((seat) => [seat.id, {
      complete: async (request: CompletionRequest): Promise<CompletionResult> => {
        const count = (counts.get(seat.id) ?? 0) + 1;
        counts.set(seat.id, count);
        const note = `NOTE-${seat.id}-${count}`;
        calls.push({ seat: seat.id, note, prompt: JSON.stringify(request.messages) });
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          text: JSON.stringify({ action: { type: 'income' }, notes: note }),
          model: request.model,
          usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 },
          latencyMs: 1,
        };
      },
    }]));
    let latest: TableSnapshot | null = null;
    const errors: string[] = [];
    const session = new MatchSession({
      def: coup,
      seats,
      request: {
        gameId: coup.id, seed: 42, speed: 8, budgetUsd: 1,
        seats: seats.map((seat) => ({ name: seat.name, kind: 'llm', modelId: seat.modelId })),
      },
      client: null,
      clientForSeat: (seat) => clients.get(seat.id) ?? null,
      store: new ResultsStore(join(dir, 'results.jsonl')),
      saveBundle: async () => undefined,
      send: (snapshot) => { latest = snapshot; },
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: (message) => errors.push(message),
      sendDebrief: () => undefined,
      debriefModel: null,
      pacing: false,
    });
    try {
      void session.start();
      const eventCount = () => (latest as TableSnapshot | null)?.eventCount ?? 0;
      const deadline = Date.now() + 5_000;
      while (eventCount() < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(eventCount()).toBeGreaterThanOrEqual(3);
      session.setPaused(true);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const events = (session as unknown as { events: MatchEvent[] }).events;
      const lastSeat = events.at(-1)!.seatId;
      const seatCalls = calls.filter((call) => call.seat === lastSeat);
      const undone = seatCalls.at(-1)!;
      const previous = seatCalls.at(-2);
      const beforeRewind = calls.length;

      await session.rewind(1);

      const nextDeadline = Date.now() + 5_000;
      let next: (typeof calls)[number] | undefined;
      while (Date.now() < nextDeadline) {
        next = calls.slice(beforeRewind).find((call) => call.seat === lastSeat);
        if (next) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(next).toBeDefined();
      expect(next!.prompt).not.toContain(undone.note);
      if (previous) expect(next!.prompt).toContain(previous.note);
      else expect(next!.prompt).toContain('(none)');
      expect(errors).toEqual([]);
    } finally {
      session.abortMatch();
    }
  }, 15_000);
});
