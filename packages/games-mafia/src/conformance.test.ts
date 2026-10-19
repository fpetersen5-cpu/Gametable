import { describe, expect, it } from 'vitest';
import { RandomBot, runMatch, type Seat } from '@gametable/engine';
import { runConformance } from '@gametable/sdk-conformance';
import { mafia } from './index.js';

describe('Mafia / Werewolf', () => {
  it('passes the cross-game conformance gate', async () => {
    const results = await runConformance(mafia, { seeds: [1, 2], playoutsPerSeatCount: 1 });
    const failed = results.filter((result) => !result.ok);
    expect(failed).toEqual([]);
  });

  it('a model can speak through the gateway and the words reach the table', async () => {
    const seats: Seat[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i + 1}`,
      name: `Seat ${i + 1}`,
      kind: 'bot',
    }));
    const bots = new Map(seats.map((seat, i) => [seat.id, new RandomBot(i + 1)]));
    const result = await runMatch(mafia, seats, bots, {
      seed: 12,
      maxActions: 1_000,
      options: { discussionRounds: 1 },
    });
    const speeches = result.metrics.speeches;
    expect(speeches).toBeGreaterThan(0);
    expect(result.seats.every((seat) => seat.metrics?.survived !== undefined)).toBe(true);
  });
});
