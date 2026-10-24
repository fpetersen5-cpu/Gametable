import { describe, expect, it } from 'vitest';
import { RandomBot, runMatch, type Seat } from '@gametable/engine';
import { runConformance } from '@gametable/sdk-conformance';
import { coup } from './index.js';

describe('Coup', () => {
  it('passes the cross-game conformance gate', async () => {
    const results = await runConformance(coup, { seeds: [1, 2], playoutsPerSeatCount: 1 });
    const failed = results.filter((result) => !result.ok);
    expect(failed).toEqual([]);
  });

  it('plays a full match with random bots and produces a winner', async () => {
    const seats: Seat[] = Array.from({ length: 4 }, (_, i) => ({
      id: `s${i + 1}`,
      name: `Seat ${i + 1}`,
      kind: 'bot',
    }));
    const bots = new Map(seats.map((seat, i) => [seat.id, new RandomBot(i + 1)]));
    const result = await runMatch(coup, seats, bots, { seed: 12, maxActions: 2_000 });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.winners.length).toBeGreaterThan(0);
    expect(result.seats.every((seat) => seat.metrics?.survived !== undefined)).toBe(true);
  });

  it('rejects a view for an unknown seat', () => {
    const seats: Seat[] = [
      { id: 's1', name: 'Seat 1', kind: 'bot' },
      { id: 's2', name: 'Seat 2', kind: 'bot' },
    ];
    const state = coup.setup({ seed: 1, seats, options: {} });
    expect(() => coup.view(state, 'ghost-seat')).toThrow(/unknown seat/);
  });

  it('projects hidden cards only to their owner', () => {
    const seats: Seat[] = [
      { id: 's1', name: 'Seat 1', kind: 'bot' },
      { id: 's2', name: 'Seat 2', kind: 'bot' },
    ];
    const state = coup.setup({ seed: 3, seats, options: {} });
    const one = coup.view(state, 's1');
    const two = coup.view(state, 's2');
    const oneData = one.data as { hand: string[] };
    const twoData = two.data as { hand: string[] };
    expect(oneData.hand).toEqual(state.hands.s1);
    expect(twoData.hand).toEqual(state.hands.s2);
    expect(oneData.hand).not.toEqual(twoData.hand);
    expect(one.legalActions.length).toBeGreaterThan(0);
    expect(two.legalActions).toEqual([]);
  });
});
