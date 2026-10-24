import { describe, expect, it } from 'vitest';
import { Rng } from '@gametable/engine';
import { seatRoster } from '@gametable/sdk-conformance';
import { coup, type CoupRole, type CoupState } from './coup.js';
import { act, invariants, lose, pass, reject, table } from './test-helpers.js';

describe('Coup setup and basic actions', () => {
  for (const count of [2, 3, 4, 5, 6]) {
    it(`deals a complete, conserved deck and correct starting coins for ${count} seats`, () => {
      const state = coup.setup({ seed: 19, seats: seatRoster(count), options: {} });
      invariants(state);
      expect(state.deck).toHaveLength(15 - count * 2);
      expect(state.discard).toEqual([]);
      expect(Object.values(state.hands).every((hand) => hand.length === 2)).toBe(true);
      expect(state.coins.s1).toBe(count === 2 ? 1 : 2);
      expect(state.coins.s2).toBe(2);
      expect(state).toEqual(coup.setup({ seed: 19, seats: seatRoster(count), options: {} }));
    });
  }

  it('rejects unsupported seat counts', () => {
    for (const count of [0, 1, 7]) {
      expect(() => coup.setup({ seed: 1, seats: seatRoster(count), options: {} })).toThrow();
    }
  });

  it('takes income immediately and cannot be challenged or blocked', () => {
    const before = table();
    const next = act(before, { type: 'income' });
    expect(next.coins.s1).toBe(3);
    expect(next.turn).toBe('s2');
    expect(next.step.kind).toBe('action');
    expect(next.stats.income).toBe(1);
    expect(next.stats.turns).toBe(2);
    reject(next, { type: 'challenge' });
    reject(next, { type: 'block', role: 'Duke' });
    expect(next.hands).toEqual(before.hands);
  });

  it('resolves foreign aid only after all potential blockers pass', () => {
    let state = act(table(), { type: 'foreign-aid' });
    expect(state.step.kind).toBe('block');
    expect(state.coins.s1).toBe(2);
    reject(state, { type: 'challenge' });
    state = act(state, { type: 'pass' });
    expect(state.step.actor).toBe('s3');
    expect(state.coins.s1).toBe(2);
    state = act(state, { type: 'pass' });
    expect(state.coins.s1).toBe(4);
    expect(state.turn).toBe('s2');
    expect(state.stats.foreignAid).toBe(1);
  });

  for (const coins of [0, 2, 3, 6, 7, 9, 10, 12]) {
    it(`enforces action costs and the mandatory coup at ${coins} coins`, () => {
      const state = table(undefined, [coins, 2, 2]);
      const actions = coup.view(state, 's1').legalActions;
      expect(actions.some((a) => a.type === 'coup')).toBe(coins >= 7);
      expect(actions.some((a) => a.type === 'assassinate')).toBe(coins >= 3 && coins < 10);
      if (coins >= 10) {
        expect(actions.every((a) => a.type === 'coup')).toBe(true);
        reject(state, { type: 'income' });
        reject(state, { type: 'assassinate', target: 's2' });
      }
      if (coins < 7) reject(state, { type: 'coup', target: 's2' });
      if (coins < 3) reject(state, { type: 'assassinate', target: 's2' });
      reject(state, { type: 'pass' });
    });
  }

  it('makes a coup unstoppable, charges once, and lets the victim choose a card', () => {
    const before = table(undefined, [7, 2, 2]);
    let state = act(before, { type: 'coup', target: 's2' });
    expect(state.coins.s1).toBe(0);
    expect(state.stats.coups).toBe(1);
    expect(state.step.kind).toBe('lose');
    expect(state.step.actor).toBe('s2');
    reject(state, { type: 'block', role: 'Contessa' });
    reject(state, { type: 'challenge' });
    state = lose(state, 'Contessa');
    expect(state.hands.s2).toEqual(['Captain']);
    expect(state.discard).toContain('Contessa');
    expect(state.coins.s1).toBe(0);
    expect(state.turn).toBe('s2');
  });
});

const claims = [
  { type: 'tax', role: 'Duke' },
  { type: 'steal', role: 'Captain', target: 's2' },
  { type: 'assassinate', role: 'Assassin', target: 's2' },
  { type: 'exchange', role: 'Ambassador' },
] as const;

describe('Coup action challenges', () => {
  for (const claim of claims) {
    it(`lets an unchallenged ${claim.type} bluff resolve without requiring its card`, () => {
      let state = table([['Contessa', 'Contessa'], ['Duke', 'Captain'], ['Assassin', 'Ambassador']], [5, 2, 2]);
      const start = structuredClone(state.hands);
      state = act(state, { ...claim });
      state = pass(state, 'challenge');
      state = pass(state, 'block');
      if (claim.type === 'tax') expect(state.coins.s1).toBe(8);
      if (claim.type === 'steal') {
        expect(state.coins.s1).toBe(7);
        expect(state.coins.s2).toBe(0);
      }
      if (claim.type === 'assassinate') {
        expect(state.coins.s1).toBe(2);
        state = lose(state);
        expect(state.hands.s2).toHaveLength(1);
      }
      if (claim.type === 'exchange') {
        expect(state.step.kind).toBe('exchange');
        state = act(state, coup.view(state, 's1').legalActions[0]!);
      }
      expect(state.turn).toBe('s2');
      if (claim.type !== 'assassinate' && claim.type !== 'exchange') expect(state.hands).toEqual(start);
    });

    it(`cancels a challenged ${claim.type} bluff and charges the claimant one influence`, () => {
      let state = table([['Contessa', 'Contessa'], ['Duke', 'Captain'], ['Assassin', 'Ambassador']], [5, 2, 2]);
      const deck = [...state.deck];
      state = act(state, { ...claim });
      state = act(state, { type: 'challenge' });
      expect(state.step.kind).toBe('prove');
      expect(state.step.actor).toBe('s1');
      expect(coup.view(state, 's1').legalActions).toEqual([{ type: 'concede' }]);
      reject(state, { type: 'prove' });
      state = act(state, { type: 'concede' });
      state = lose(state, 'Contessa');
      expect(state.hands.s1).toHaveLength(1);
      expect(state.hands.s2).toHaveLength(2);
      expect(state.coins.s1).toBe(5); // assassination cost is refunded on successful challenge
      expect(state.coins.s2).toBe(2);
      expect(state.deck).toEqual(deck); // failed Exchange must not draw
      expect(state.step.kind).toBe('action');
      expect(state.turn).toBe('s2');
    });

    it(`proves ${claim.role}, replaces exactly that card, and then continues ${claim.type}`, () => {
      let state = table([[claim.role, 'Contessa'], ['Duke', 'Captain'], ['Assassin', 'Ambassador']], [5, 2, 2]);
      state = act(state, { ...claim });
      state = act(state, { type: 'challenge' });
      const rng = Rng.restore(state.rngState);
      const expectedDeck = rng.shuffle([...state.deck, claim.role]);
      const replacement = expectedDeck.shift()!;
      state = act(state, { type: 'prove' });
      expect(state.hands.s1).toEqual(['Contessa', replacement]);
      expect(state.deck).toEqual(expectedDeck);
      expect(state.rngState).toBe(rng.snapshot());
      expect(state.step.actor).toBe('s2');
      expect(state.step.kind).toBe('lose');
      state = lose(state, 'Duke');
      expect(state.hands.s2).toEqual(['Captain']);
      if (claim.type === 'steal' || claim.type === 'assassinate') {
        expect(state.step.kind).toBe('block');
        state = pass(state, 'block');
      }
      if (claim.type === 'assassinate') state = lose(state, 'Captain');
      if (claim.type === 'exchange') state = act(state, coup.view(state, 's1').legalActions[0]!);
      expect(state.turn).toBe(claim.type === 'assassinate' ? 's3' : 's2');
    });
  }

  it('lets a player concede despite holding the claimed card', () => {
    let state = act(table(), { type: 'tax' });
    state = act(state, { type: 'challenge' });
    expect(coup.view(state, 's1').legalActions).toContainEqual({ type: 'prove' });
    expect(coup.view(state, 's1').legalActions).toContainEqual({ type: 'concede' });
    const deck = [...state.deck];
    state = act(state, { type: 'concede' });
    state = lose(state, 'Assassin');
    expect(state.hands.s1).toEqual(['Duke']);
    expect(state.deck).toEqual(deck);
    expect(state.coins.s1).toBe(2);
  });

  it('allows a third party to challenge a targeted action', () => {
    let state = act(table(undefined, [3, 2, 2]), { type: 'assassinate', target: 's2' });
    state = act(state, { type: 'pass' }); // target declines to challenge
    expect(state.step.actor).toBe('s3');
    state = act(state, { type: 'challenge' });
    expect(state.step.actor).toBe('s1');
    state = act(state, { type: 'prove' });
    expect(state.step.actor).toBe('s3');
    state = lose(state);
    expect(state.step.kind).toBe('block');
    expect(state.step.actor).toBe('s2');
  });
});

const blocks = [
  { type: 'foreign-aid', role: 'Duke' },
  { type: 'steal', role: 'Captain', target: 's2' },
  { type: 'steal', role: 'Ambassador', target: 's2' },
  { type: 'assassinate', role: 'Contessa', target: 's2' },
] as const;

function blockAttempt(block: typeof blocks[number], truthful: boolean): CoupState {
  const hand: CoupRole[] = truthful ? [block.role, 'Assassin'] : ['Assassin', 'Assassin'];
  let state = table([['Duke', 'Contessa'], hand, ['Captain', 'Ambassador']], [5, 4, 2]);
  state = act(state, { ...block });
  state = pass(state, 'challenge');
  expect(state.step.actor).toBe('s2');
  return act(state, { type: 'block', role: block.role });
}

describe('Coup blocks and counter-challenges', () => {
  for (const block of blocks) {
    it(`accepts an unchallenged ${block.role} bluff against ${block.type}`, () => {
      let state = blockAttempt(block, false);
      state = pass(state, 'challenge-block');
      expect(state.step.kind).toBe('action');
      expect(state.turn).toBe('s2');
      expect(state.coins.s1).toBe(block.type === 'assassinate' ? 2 : 5);
      expect(state.coins.s2).toBe(4);
      expect(state.hands.s2).toHaveLength(2);
      expect(state.stats.blocks).toBe(1);
    });

    it(`cancels a truthful ${block.role} block challenge against ${block.type}`, () => {
      let state = blockAttempt(block, true);
      const otherCard = state.hands.s2![1]!;
      state = act(state, { type: 'challenge' });
      state = act(state, { type: 'prove' });
      expect(state.hands.s2).toHaveLength(2);
      expect(state.hands.s2![0]).toBe(otherCard);
      expect(state.step.actor).toBe('s1');
      state = lose(state);
      expect(state.hands.s1).toHaveLength(1);
      expect(state.coins.s1).toBe(block.type === 'assassinate' ? 2 : 5);
      expect(state.coins.s2).toBe(4);
      expect(state.turn).toBe('s2');
    });

    it(`resumes ${block.type} after exposing a false ${block.role} block`, () => {
      let state = blockAttempt(block, false);
      state = act(state, { type: 'challenge' });
      expect(coup.view(state, 's2').legalActions).toEqual([{ type: 'concede' }]);
      state = act(state, { type: 'concede' });
      state = lose(state, 'Assassin');
      if (block.type === 'assassinate') {
        expect(state.step.kind).toBe('lose');
        expect(state.step.actor).toBe('s2');
        state = lose(state, 'Assassin');
        expect(state.hands.s2).toEqual([]); // challenge loss + assassination
        expect(state.turn).toBe('s3');
        expect(state.coins.s1).toBe(2);
      } else {
        expect(state.coins.s1).toBe(7);
        expect(state.hands.s2).toHaveLength(1);
        expect(state.turn).toBe('s2');
      }
    });
  }

  it('offers third parties a block challenge after the action owner passes', () => {
    let state = blockAttempt(blocks[0], false);
    state = act(state, { type: 'pass' });
    expect(state.step.kind).toBe('challenge-block');
    expect(state.step.actor).toBe('s3');
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'concede' });
    state = lose(state);
    expect(state.coins.s1).toBe(7);
    expect(state.hands.s3).toHaveLength(2);
  });

  it('allows any rival to block foreign aid, but only a target to block steal or assassination', () => {
    let aid = act(table(), { type: 'foreign-aid' });
    aid = act(aid, { type: 'pass' });
    expect(aid.step.actor).toBe('s3');
    expect(coup.view(aid, 's3').legalActions).toContainEqual({ type: 'block', role: 'Duke' });
    for (const type of ['steal', 'assassinate']) {
      const state = pass(act(table(undefined, [3, 2, 2]), { type, target: 's2' }), 'challenge');
      reject(state, { type: 'block', role: type === 'steal' ? 'Captain' : 'Contessa' }, 's3');
    }
  });

  it('rejects unrelated block roles and retroactive action challenges', () => {
    const state = pass(act(table(undefined, [3, 2, 2]), { type: 'assassinate', target: 's2' }), 'challenge');
    reject(state, { type: 'block', role: 'Duke' });
    reject(state, { type: 'block', role: 'Captain' });
    reject(state, { type: 'challenge' });
  });
});

describe('Coup elimination, continuation and scoring', () => {
  it('lets a one-influence assassination target challenge and die without a second loss', () => {
    let state = table([['Assassin', 'Duke'], ['Captain'], ['Ambassador', 'Contessa']], [3, 5, 2]);
    state = act(state, { type: 'assassinate', target: 's2' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    state = lose(state);
    expect(state.hands.s2).toEqual([]);
    expect(state.coins.s2).toBe(0);
    expect(state.step.kind).toBe('action');
    expect(state.turn).toBe('s3');
    expect(state.stats.eliminations).toBe(1);
  });

  it('continues an action after a third-party challenger is eliminated', () => {
    let state = table([['Duke', 'Assassin'], ['Captain', 'Contessa'], ['Ambassador']], [2, 2, 7]);
    state = act(state, { type: 'tax' });
    state = act(state, { type: 'pass' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'prove' });
    state = lose(state);
    expect(state.hands.s3).toEqual([]);
    expect(state.coins.s3).toBe(0);
    expect(state.coins.s1).toBe(5);
    expect(state.turn).toBe('s2');
  });

  it('skips an eliminated turn owner after their false action is challenged', () => {
    let state = table([['Contessa'], ['Captain', 'Duke'], ['Assassin', 'Ambassador']]);
    state = act(state, { type: 'tax' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'concede' });
    state = lose(state);
    expect(state.turn).toBe('s2');
    expect(state.coins.s1).toBe(0);
    expect(state.hands.s1).toEqual([]);
  });

  it('settles a pending steal before returning the eliminated victim’s remaining coins', () => {
    let state = table([['Captain', 'Contessa'], ['Duke'], ['Assassin', 'Ambassador']], [2, 5, 2]);
    state = pass(act(state, { type: 'steal', target: 's2' }), 'challenge');
    state = act(state, { type: 'block', role: 'Ambassador' });
    state = act(state, { type: 'challenge' });
    state = act(state, { type: 'concede' });
    state = lose(state, 'Duke');
    expect(state.coins.s1).toBe(4);
    expect(state.coins.s2).toBe(0);
    expect(state.stats.steals).toBe(1);
    expect(state.turn).toBe('s3');
  });

  for (const coins of [1, 2, 5]) {
    it(`steals no more than two of a target’s ${coins} coins`, () => {
      const state = pass(pass(act(table(undefined, [2, coins, 2]), { type: 'steal', target: 's2' }), 'challenge'), 'block');
      expect(state.coins.s1).toBe(2 + Math.min(2, coins));
      expect(state.coins.s2).toBe(Math.max(0, coins - 2));
    });
  }

  it('ends immediately with exactly one winner and no phantom next turn', () => {
    let state = table([['Duke'], ['Captain']], [7, 5]);
    state = act(state, { type: 'coup', target: 's2' });
    state = lose(state, 'Captain');
    expect(coup.terminal(state)).toBe(true);
    expect(coup.scoring(state)).toEqual({ winners: ['s1'], scores: { s1: 1, s2: 0 } });
    expect(state.stats.turns).toBe(1);
    expect(state.coins.s2).toBe(0);
    expect(coup.metricsFor!(state, 's2')).toMatchObject({ influence: 0, coins: 0, survived: 0 });
    reject(state, { type: 'income' }, 's1');
  });

  it('prevents self-targets, eliminated targets, out-of-turn moves and invented loss choices', () => {
    let state = table([['Duke', 'Assassin'], ['Captain', 'Contessa'], []], [7, 2, 0]);
    for (const target of ['s1', 's3', 'ghost']) reject(state, { type: 'coup', target });
    reject(state, { type: 'income' }, 's2');
    state = act(state, { type: 'coup', target: 's2' });
    reject(state, { type: 'lose', card: 'Duke' });
    reject(state, { type: 'pass' });
  });
});
