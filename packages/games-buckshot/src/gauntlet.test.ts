import { describe, expect, it } from 'vitest';
import { RandomBot, type Seat } from '@gametable/engine';
import { runGauntlet } from './gauntlet.js';

const hero: Seat = { id: 'hero', name: 'You', kind: 'bot' };

function opponent(index: number): { seat: Seat; controller: RandomBot } {
  return {
    seat: { id: `opp${index}`, name: `Bot ${index}`, kind: 'bot' },
    controller: new RandomBot(200 + index),
  };
}

describe('gauntlet', () => {
  it('plays one duel per opponent and keeps up to two items', async () => {
    const result = await runGauntlet({
      hero,
      heroController: new RandomBot(1),
      opponents: [opponent(1), opponent(2), opponent(3)],
      seed: 5,
    });

    expect(result.duels).toHaveLength(3);
    expect(result.duelsWon).toBeGreaterThanOrEqual(0);
    expect(result.duelsWon).toBeLessThanOrEqual(3);
    expect(result.roundWins).toBeGreaterThan(0);
    for (const duel of result.duels) {
      expect(duel.carried.length).toBeLessThanOrEqual(2);
      expect(duel.result.winners).toHaveLength(1);
    }
  });

  it('is reproducible from the seed', async () => {
    const run = () =>
      runGauntlet({
        hero,
        heroController: new RandomBot(9),
        opponents: [opponent(1), opponent(2)],
        seed: 77,
      });
    const first = await run();
    const second = await run();
    expect(first.duels.map((d) => d.result.scores)).toEqual(second.duels.map((d) => d.result.scores));
  });
});
