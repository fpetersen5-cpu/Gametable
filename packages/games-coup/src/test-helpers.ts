import { expect } from 'vitest';
import { IllegalAction, type GameAction } from '@gametable/engine';
import { seatRoster } from '@gametable/sdk-conformance';
import { COUP_ROLES, coup, type CoupRole, type CoupState } from './coup.js';

/** Rig known hands while conserving the actual 15-card deck. */
export function table(
  hands: CoupRole[][] = [['Duke', 'Assassin'], ['Captain', 'Contessa'], ['Ambassador', 'Duke']],
  coins: number[] = hands.map(() => 2),
): CoupState {
  const state = coup.setup({ seed: 42, seats: seatRoster(hands.length), options: {} });
  const pool = COUP_ROLES.flatMap((role) => [role, role, role]);
  hands.forEach((hand, i) => {
    state.hands[`s${i + 1}`] = [...hand];
    state.coins[`s${i + 1}`] = coins[i] ?? 2;
    for (const card of hand) {
      const index = pool.indexOf(card);
      if (index < 0) throw new Error(`Fixture has more than three ${card} cards`);
      pool.splice(index, 1);
    }
  });
  // Missing influence slots represent already revealed, out-of-play cards.
  state.discard = pool.splice(0, hands.length * 2 - hands.flat().length);
  state.deck = pool;
  state.stats.eliminations = hands.filter((hand) => hand.length === 0).length;
  state.seats.forEach((seat) => { if (!state.hands[seat.id]!.length) state.coins[seat.id] = 0; });
  state.turn = state.seats.find((seat) => state.hands[seat.id]!.length > 0)!.id;
  state.step = { kind: 'action', actor: state.turn };
  return state;
}

export function invariants(state: CoupState): void {
  const cards = [...state.deck, ...state.discard, ...Object.values(state.hands).flat(),
    ...(state.step.kind === 'exchange' ? state.step.cards : [])];
  expect(cards).toHaveLength(15);
  for (const role of COUP_ROLES) expect(cards.filter((card) => card === role)).toHaveLength(3);
  for (const seat of state.seats) {
    expect(state.hands[seat.id]!.length).toBeLessThanOrEqual(2);
    expect(Number.isInteger(state.coins[seat.id])).toBe(true);
    expect(state.coins[seat.id]).toBeGreaterThanOrEqual(0);
    if (state.hands[seat.id]!.length === 0) expect(state.coins[seat.id]).toBe(0);
    const view = coup.view(state, seat.id);
    if (!coup.terminal(state) && seat.id === state.step.actor) {
      expect(state.hands[seat.id]!.length).toBeGreaterThan(0);
      expect(view.legalActions.length).toBeGreaterThan(0);
    } else {
      expect(view.legalActions).toEqual([]);
    }
  }
}

export function act(state: CoupState, action: GameAction, seatId = state.step.actor): CoupState {
  const original = structuredClone(state);
  const next = coup.apply(state, seatId, action);
  expect(state).toEqual(original);
  expect(next.discard.slice(0, state.discard.length)).toEqual(state.discard);
  invariants(next);
  return next;
}

export function reject(state: CoupState, action: GameAction, seatId = state.step.actor): void {
  const original = structuredClone(state);
  expect(() => coup.apply(state, seatId, action)).toThrow(IllegalAction);
  expect(state).toEqual(original);
}

export function pass(state: CoupState, kind: 'challenge' | 'block' | 'challenge-block'): CoupState {
  let next = state;
  for (let i = 0; next.step.kind === kind; i++) {
    if (i > 6) throw new Error(`Reaction queue did not finish: ${kind}`);
    next = act(next, { type: 'pass' });
  }
  return next;
}

export function lose(state: CoupState, card = state.hands[state.step.actor]![0]!): CoupState {
  expect(state.step.kind).toBe('lose');
  return act(state, { type: 'lose', card });
}
