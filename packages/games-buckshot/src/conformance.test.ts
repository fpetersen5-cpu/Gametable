import { describe, expect, it } from 'vitest';
import { RandomBot, runMatch, type Seat } from '@gametable/engine';
import { runConformance } from '@gametable/sdk-conformance';
import { buckshot } from './index.js';

describe('Buckshot Roulette', () => {
  it('passes the cross-game conformance gate', async () => {
    const results = await runConformance(buckshot, { seeds: [1, 2], playoutsPerSeatCount: 2 });
    const failed = results.filter((result) => !result.ok);
    expect(failed).toEqual([]);
  });

  it('records per-seat optimality when asked', async () => {
    const seats: Seat[] = [
      { id: 's1', name: 'A', kind: 'bot' },
      { id: 's2', name: 'B', kind: 'bot' },
    ];
    const bots = new Map([
      ['s1', new RandomBot(4)],
      ['s2', new RandomBot(5)],
    ]);
    const result = await runMatch(buckshot, seats, bots, {
      seed: 21,
      maxActions: 300,
      options: { trackOptimality: true },
    });
    const seatMetrics = result.seats.map((seat) => seat.metrics ?? {});
    expect(seatMetrics.every((metrics) => typeof metrics.decisions === 'number')).toBe(true);
    expect(seatMetrics.some((metrics) => (metrics.decisions ?? 0) > 0)).toBe(true);
    expect(result.metrics.shots).toBeGreaterThan(0);
  });
});
