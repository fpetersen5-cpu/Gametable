import { describe, expect, it } from 'vitest';
import { duelPair } from './arena.js';

describe('arena duel pairings', () => {
  it('cycles every adjacent pair and wraps', () => {
    const names = ['A', 'B', 'C', 'D'];
    expect(names.map((_, index) => duelPair(names, index).join('-'))).toEqual([
      'A-B',
      'B-C',
      'C-D',
      'D-A',
    ]);
  });

  it('rejects a lineup with fewer than two seats', () => {
    expect(() => duelPair(['A'], 0)).toThrow(/two seats/);
  });
});
