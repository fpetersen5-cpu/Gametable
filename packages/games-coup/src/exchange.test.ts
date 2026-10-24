import { describe, expect, it } from 'vitest';
import { Rng } from '@gametable/engine';
import { coup, type CoupRole, type CoupState } from './coup.js';
import { act, pass, reject, table } from './test-helpers.js';

function putOnTop(state: CoupState, roles: CoupRole[]): void {
  const rest = [...state.deck];
  for (const role of roles) {
    const index = rest.indexOf(role);
    if (index < 0) throw new Error(`Fixture cannot draw ${role}`);
    rest.splice(index, 1);
  }
  state.deck = [...roles, ...rest];
}

describe('Coup exchange rules', () => {
  it('does not draw until all action challengers pass', () => {
    const before = table();
    let state = act(before, { type: 'exchange' });
    expect(state.deck).toEqual(before.deck);
    expect((coup.view(state, 's1').data as Record<string, unknown>).exchangeCards).toBeUndefined();
    state = act(state, { type: 'pass' });
    expect(state.deck).toEqual(before.deck);
    state = act(state, { type: 'pass' });
    expect(state.step.kind).toBe('exchange');
    if (state.step.kind !== 'exchange') throw new Error('wrong step');
    expect(state.step.cards).toEqual(before.deck.slice(0, 2));
    expect(state.deck).toEqual(before.deck.slice(2));
    expect(state.hands).toEqual(before.hands);
  });

  for (const count of [1, 2]) {
    it(`keeps exactly ${count} influence and returns exactly two shuffled cards`, () => {
      const hand: CoupRole[] = count === 1 ? ['Ambassador'] : ['Ambassador', 'Duke'];
      let state = table([hand, ['Captain', 'Contessa'], ['Assassin', 'Duke']]);
      const discard = [...state.discard];
      putOnTop(state, ['Captain', 'Assassin']);
      const originalDeckLength = state.deck.length;
      state = pass(act(state, { type: 'exchange' }), 'challenge');
      const keep = coup.view(state, 's1').legalActions.find((action) => action.first === 'Captain')!;
      expect(keep).toBeDefined();
      expect('second' in keep).toBe(count === 2);
      const before = structuredClone(state);
      state = act(state, keep);
      expect(state.hands.s1).toHaveLength(count);
      expect(state.hands.s1).toContain('Captain');
      expect(state.deck).toHaveLength(originalDeckLength);
      expect(state.discard).toEqual(discard);
      expect(state.stats.exchanges).toBe(1);
      expect(state.turn).toBe('s2');
      if (before.step.kind !== 'exchange') throw new Error('wrong step');
      const rest = [...before.hands.s1!, ...before.step.cards];
      for (const card of state.hands.s1!) rest.splice(rest.indexOf(card), 1);
      expect(rest).toHaveLength(2);
      const rng = Rng.restore(before.rngState);
      expect(state.deck).toEqual(rng.shuffle([...before.deck, ...rest]));
      expect(state.rngState).toBe(rng.snapshot());
    });
  }

  it('deduplicates equivalent choices but permits keeping two identical cards', () => {
    let state = table([['Contessa', 'Contessa'], ['Assassin', 'Captain'], ['Ambassador', 'Duke']]);
    putOnTop(state, ['Duke', 'Duke']);
    state = pass(act(state, { type: 'exchange' }), 'challenge');
    const choices = coup.view(state, 's1').legalActions;
    expect(choices).toHaveLength(3);
    expect(choices).toContainEqual({ type: 'keep', first: 'Duke', second: 'Duke' });
    expect(choices).toContainEqual({ type: 'keep', first: 'Contessa', second: 'Contessa' });
    const keys = choices.map((action) => [action.first, action.second].sort().join('/'));
    expect(new Set(keys).size).toBe(choices.length);
    state = act(state, { type: 'keep', first: 'Duke', second: 'Duke' });
    expect(state.hands.s1).toEqual(['Duke', 'Duke']);
    expect(state.deck.filter((card) => card === 'Contessa')).toHaveLength(3);
  });

  it('can retain the original hand instead of either drawn card', () => {
    let state = table();
    const original = [...state.hands.s1!];
    state = pass(act(state, { type: 'exchange' }), 'challenge');
    state = act(state, { type: 'keep', first: original[0], second: original[1] });
    expect(state.hands.s1).toEqual(original);
  });

  it('rejects unavailable cards, invented duplicates and the wrong number of keep choices', () => {
    let two = table();
    putOnTop(two, ['Captain', 'Ambassador']);
    two = pass(act(two, { type: 'exchange' }), 'challenge');
    reject(two, { type: 'keep', first: 'Duke' });
    reject(two, { type: 'keep', first: 'Duke', second: 'Duke' });
    reject(two, { type: 'keep', first: 'Contessa', second: 'Duke' });
    reject(two, { type: 'income' });
    let one = table([['Ambassador'], ['Duke', 'Captain'], ['Assassin', 'Contessa']]);
    one = pass(act(one, { type: 'exchange' }), 'challenge');
    // Surplus fields are stripped by the engine's action normalizer. They must
    // not let a one-influence player retain a second card.
    const first = coup.view(one, 's1').legalActions[0]!.first;
    const kept = act(one, { type: 'keep', first, second: first });
    expect(kept.hands.s1).toHaveLength(1);
  });

  it('works with the three-card Court deck at the six-seat limit', () => {
    let state = table([
      ['Ambassador', 'Duke'], ['Captain', 'Contessa'], ['Assassin', 'Duke'],
      ['Ambassador', 'Captain'], ['Assassin', 'Contessa'], ['Ambassador', 'Assassin'],
    ]);
    expect(state.deck).toHaveLength(3);
    state = pass(act(state, { type: 'exchange' }), 'challenge');
    expect(state.deck).toHaveLength(1);
    state = act(state, coup.view(state, 's1').legalActions[0]!);
    expect(state.deck).toHaveLength(3);
  });

  it('rejects a corrupt short deck rather than resurrecting revealed losses', () => {
    let state = table([['Ambassador'], ['Duke', 'Captain'], ['Assassin', 'Contessa']]);
    state = act(state, { type: 'exchange' });
    state = act(state, { type: 'pass' });
    state.deck = [];
    const original = structuredClone(state);
    expect(() => coup.apply(state, state.step.actor, { type: 'pass' })).toThrow(/Court deck/);
    expect(state).toEqual(original);
  });
});
