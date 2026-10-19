import { describe, expect, it } from 'vitest';
import { bradleyTerry, type MatchRecord } from './index.js';

function record(id: string, winner: string, loser: string): MatchRecord {
  return {
    matchId: id,
    gameId: 'test.game',
    gameVersion: '1.0.0',
    engineVersion: '0.1.0',
    seed: 1,
    startedAt: 0,
    durationMs: 10,
    seats: [
      { seatId: 'w', name: 'W', kind: 'llm', modelId: winner, tokensIn: 100, tokensOut: 10, costUsd: 0.001, latencyMs: 500, invalidActions: 0, fallbacks: 0 },
      { seatId: 'l', name: 'L', kind: 'llm', modelId: loser, tokensIn: 100, tokensOut: 10, costUsd: 0.002, latencyMs: 900, invalidActions: 1, fallbacks: 0 },
    ],
    winnerSeats: ['w'],
    scores: { w: 1, l: 0 },
    metrics: { probes: 3 },
  };
}

describe('bradleyTerry', () => {
  it('ranks the consistently winning model above the loser', () => {
    const records = Array.from({ length: 8 }, (_, i) => record(`m${i}`, 'good/model', 'bad/model'));
    const ratings = bradleyTerry(records);
    expect(ratings[0]?.modelId).toBe('good/model');
    expect(ratings[0]?.rating).toBeGreaterThan(1500);
    expect(ratings[1]?.rating).toBeLessThan(1500);
    expect(ratings[0]?.wins).toBe(8);
    expect(ratings[1]?.losses).toBe(8);
  });

  it('keeps evenly matched models level', () => {
    const records = [
      record('a', 'x/model', 'y/model'),
      record('b', 'y/model', 'x/model'),
    ];
    const ratings = bradleyTerry(records);
    expect(Math.abs((ratings[0]?.rating ?? 0) - (ratings[1]?.rating ?? 0))).toBeLessThan(1);
  });

  it('ignores human and bot seats', () => {
    const withHuman = record('m', 'x/model', 'y/model');
    withHuman.seats.push({ seatId: 'h', name: 'You', kind: 'human', tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, invalidActions: 0, fallbacks: 0 });
    withHuman.winnerSeats.push('h');
    const ratings = bradleyTerry([withHuman]);
    expect(ratings.map((r) => r.modelId).sort()).toEqual(['x/model', 'y/model']);
  });

  it('reports nothing for a history with no model-vs-model matches', () => {
    expect(bradleyTerry([])).toEqual([]);
  });
});
