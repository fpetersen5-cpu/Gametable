import { describe, expect, it } from 'vitest';
import { Rng, type GameAction } from '@gametable/engine';
import { seatRoster } from '@gametable/sdk-conformance';
import { coup } from './coup.js';
import { act, invariants, lose, pass, table } from './test-helpers.js';

describe('Coup deterministic legal playouts', () => {
  for (const count of [2, 3, 4, 5, 6]) {
    it(`preserves cards, coins, purity and JSON replay across 12 seeds with ${count} seats`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const seats = seatRoster(count);
        let state = coup.setup({ seed, seats, options: {} });
        let replay = structuredClone(state);
        const chooser = Rng.fromSeed(seed * 177);
        let actions = 0;
        invariants(state);
        while (!coup.terminal(state)) {
          if (++actions > 1500) throw new Error(`Possible deadlock with ${count} seats, seed ${seed}`);
          const actor = coup.phase(state).actor!;
          const legal = coup.view(state, actor).legalActions;
          const action = chooser.pick(legal);
          const previous = state;
          const snapshot = structuredClone(state);
          state = coup.apply(state, actor, action);
          expect(previous).toEqual(snapshot);
          expect(snapshot).toEqual(replay);
          replay = coup.apply(JSON.parse(JSON.stringify(replay)), actor, JSON.parse(JSON.stringify(action)));
          expect(state).toEqual(replay);
          expect(state.discard.slice(0, snapshot.discard.length)).toEqual(snapshot.discard);
          invariants(state);
        }
        expect(coup.scoring(state).winners).toHaveLength(1);
      }
    });
  }

  it('normalizes surplus action fields instead of trusting forged coins or cards', () => {
    const before = table();
    const action: GameAction = { type: 'income', coins: 999, hand: ['Duke', 'Duke'], next: 'resolve-action' };
    const after = act(before, action);
    expect(after.coins.s1).toBe(3);
    expect(after.hands).toEqual(before.hands);
    expect(after.step).toEqual({ kind: 'action', actor: 's2' });
  });
});

describe('Coup continuation edge cases', () => {
  it('permits a truthful Contessa block after the target loses an action challenge', () => {
    let state = table([['Assassin', 'Duke'], ['Captain', 'Contessa'], ['Ambassador', 'Duke']], [3, 2, 2]);
    state = act(state, { type: 'assassinate', target: 's2' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    state = lose(state, 'Captain');
    expect(state.step.kind).toBe('block');
    state = act(state, { type: 'block', role: 'Contessa' });
    state = pass(state, 'challenge-block');
    expect(state.hands.s2).toEqual(['Contessa']);
    expect(state.coins.s1).toBe(0);
    expect(state.turn).toBe('s2');
  });

  it('lets a truthful blocker concede and retain that role until the attack resolves', () => {
    let state = table([['Assassin', 'Duke'], ['Captain', 'Contessa'], ['Ambassador', 'Duke']], [3, 2, 2]);
    state = pass(act(state, { type: 'assassinate', target: 's2' }), 'challenge');
    state = act(state, { type: 'block', role: 'Contessa' });
    state = act(state, { type: 'challenge' });
    expect(coup.view(state, 's2').legalActions).toContainEqual({ type: 'prove' });
    state = act(state, { type: 'concede' });
    state = lose(state, 'Captain');
    expect(state.hands.s2).toEqual(['Contessa']);
    expect(state.step.kind).toBe('lose');
    // Conceding the first block does not open a second Contessa block window.
    expect(coup.view(state, 's2').legalActions).toEqual([{ type: 'lose', card: 'Contessa' }]);
    state = lose(state, 'Contessa');
    expect(state.hands.s2).toEqual([]);
    expect(state.turn).toBe('s3');
  });

  it('refunds assassination costs even when a truthful Assassin elects to concede', () => {
    let state = act(table(undefined, [5, 2, 2]), { type: 'assassinate', target: 's2' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'concede' });
    expect(state.coins.s1).toBe(5);
    state = lose(state, 'Duke');
    expect(state.hands.s1).toEqual(['Assassin']);
    expect(state.hands.s2).toHaveLength(2);
    expect(state.turn).toBe('s2');
  });

  it('keeps a proven block in force after a third-party challenger is eliminated', () => {
    let state = table([['Assassin', 'Contessa'], ['Duke', 'Captain'], ['Ambassador']], [2, 2, 5]);
    state = act(state, { type: 'foreign-aid' });
    state = act(state, { type: 'block', role: 'Duke' });
    state = act(state, { type: 'pass' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    expect(state.step.actor).toBe('s3');
    state = lose(state);
    expect(state.hands.s3).toEqual([]);
    expect(state.coins.s3).toBe(0);
    expect(state.coins.s1).toBe(2);
    expect(state.turn).toBe('s2');
  });

  it('skips the action owner after they lose their last influence challenging a truthful block', () => {
    let state = table([['Assassin'], ['Contessa', 'Duke'], ['Captain', 'Ambassador']], [3, 2, 2]);
    state = pass(act(state, { type: 'assassinate', target: 's2' }), 'challenge');
    state = act(state, { type: 'block', role: 'Contessa' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    state = lose(state);
    expect(state.hands.s1).toEqual([]);
    expect(state.coins.s1).toBe(0);
    expect(state.hands.s2).toHaveLength(2);
    expect(state.turn).toBe('s2');
  });

  it('settles a steal when its one-influence target loses their own challenge', () => {
    let state = table([['Captain', 'Contessa'], ['Duke'], ['Assassin', 'Ambassador']], [2, 5, 2]);
    state = act(state, { type: 'steal', target: 's2' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    state = lose(state, 'Duke');
    expect(state.coins.s1).toBe(4);
    expect(state.coins.s2).toBe(0);
    expect(state.stats.steals).toBe(1);
    expect(state.turn).toBe('s3');
  });

  it('settles the last pending theft even when the victim’s elimination ends the duel', () => {
    let state = table([['Captain'], ['Duke']], [2, 5]);
    state = act(state, { type: 'steal', target: 's2' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    state = lose(state, 'Duke');
    expect(coup.terminal(state)).toBe(true);
    expect(coup.scoring(state).winners).toEqual(['s1']);
    expect(state.coins).toEqual({ s1: 4, s2: 0 });
    expect(state.stats.steals).toBe(1);
    expect(state.stats.turns).toBe(1);
  });

  it('never offers challenges or blocks to eliminated seats', () => {
    let state = table([['Duke', 'Assassin'], [], ['Captain', 'Contessa'], []]);
    state = act(state, { type: 'foreign-aid' });
    expect(state.step.actor).toBe('s3');
    state = act(state, { type: 'block', role: 'Duke' });
    if (state.step.kind !== 'challenge-block') throw new Error('wrong step');
    expect(state.step.queue).toEqual(['s1']);
    state = pass(state, 'challenge-block');
    expect(state.turn).toBe('s3');
  });
});
