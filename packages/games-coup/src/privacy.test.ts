import { describe, expect, it } from 'vitest';
import { assertViewNonInterference, seatRoster } from '@gametable/sdk-conformance';
import { findLeaks, type GameDef } from '@gametable/engine';
import { coup, type CoupState } from './coup.js';
import { act, table } from './test-helpers.js';

describe('Coup hidden-information boundaries', () => {
  it('keeps other hands and the deck independent of every seat’s view and model request', () => {
    for (let count = coup.minSeats; count <= coup.maxSeats; count++) {
      for (const seed of [1, 2, 3, 7]) {
        const before = coup.setup({ seed, seats: seatRoster(count), options: {} });
        for (const viewer of before.seats) {
          for (const other of before.seats.filter((seat) => seat.id !== viewer.id)) {
            const changed = structuredClone(before);
            // Preserve the deck composition and both influence counts.
            [changed.hands[other.id]![0], changed.deck[0]] = [before.deck[0]!, before.hands[other.id]![0]!];
            changed.deck.reverse();
            changed.rngState += 1;
            assertViewNonInterference(coup, viewer.id, before, changed);
          }
        }
      }
    }
  });

  it('hides exchange draws from all non-actors, but shows them to the exchanging seat', () => {
    const before = coup.setup({ seed: 1, seats: seatRoster(3), options: {} });
    before.step = {
      kind: 'exchange', actor: 's1', action: { type: 'exchange', actor: 's1', claimedRole: 'Ambassador' },
      cards: before.deck.splice(0, 2),
    };
    const changed = structuredClone(before);
    if (changed.step.kind !== 'exchange') throw new Error('bad fixture');
    // A different draw, with no change to another seat’s cards or public counts.
    const first = changed.step.cards[0]!;
    const replacement = changed.deck.findIndex((card) => card !== first);
    expect(replacement).toBeGreaterThanOrEqual(0);
    [changed.step.cards[0], changed.deck[replacement]] = [changed.deck[replacement]!, first];
    for (const viewer of ['s2', 's3']) assertViewNonInterference(coup, viewer, before, changed);
    expect(coup.view(before, 's1')).not.toEqual(coup.view(changed, 's1'));
  });

  it('detects an actual raw hand leak that synthetic secret markers miss', () => {
    const before = coup.setup({ seed: 1, seats: seatRoster(2), options: {} });
    const changed = structuredClone(before);
    changed.hands.s2 = ['Duke', 'Duke'];
    const leaky: GameDef<CoupState> = {
      ...coup,
      view(state, seatId) {
        const safe = coup.view(state, seatId);
        return { ...safe, data: { ...(safe.data as object), hiddenHands: state.hands } };
      },
    };
    expect(findLeaks(leaky, before, ['s1'])).toEqual([]);
    expect(() => assertViewNonInterference(leaky, 's1', before, changed)).toThrow(/Hidden information/);
  });

  it('hides whether another seat can prove a challenged claim until they respond', () => {
    let before = act(table(), { type: 'tax' });
    before = act(before, { type: 'challenge' });
    const changed = structuredClone(before);
    const replacement = changed.deck.findIndex((card) => card !== 'Duke');
    [changed.hands.s1![0], changed.deck[replacement]] = [changed.deck[replacement]!, 'Duke'];
    for (const viewer of ['s2', 's3']) assertViewNonInterference(coup, viewer, before, changed);
    expect(coup.view(before, 's1').legalActions).toContainEqual({ type: 'prove' });
    expect(coup.view(changed, 's1').legalActions).not.toContainEqual({ type: 'prove' });
  });

  it('keeps the replacement card drawn after a proof private', () => {
    let before = act(table(), { type: 'tax' });
    before = act(before, { type: 'challenge' });
    const proved = act(before, { type: 'prove' });
    let differentReplacement = false;
    for (let shift = 1; shift < before.deck.length; shift++) {
      const alternative = structuredClone(before);
      alternative.deck = [...before.deck.slice(shift), ...before.deck.slice(0, shift)];
      const other = act(alternative, { type: 'prove' });
      for (const viewer of ['s2', 's3']) assertViewNonInterference(coup, viewer, proved, other);
      differentReplacement ||= JSON.stringify(proved.hands.s1) !== JSON.stringify(other.hands.s1);
    }
    expect(differentReplacement).toBe(true);
  });
});
