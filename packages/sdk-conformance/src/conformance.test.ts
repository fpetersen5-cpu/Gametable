import { describe, expect, it } from 'vitest';
import { runConformance } from './index.js';
import { mines } from './toy-mines.js';

/**
 * The fixture proves the gate has something to say about a game that is
 * neither Mafia nor Buckshot. The shipped games run the same suite from their
 * own packages.
 */
describe('SDK fixture: toy.mines', () => {
  it('passes the cross-game conformance gate', async () => {
    const results = await runConformance(mines, { seeds: [1, 2, 3, 4] });
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThan(6);
  });
});
