import { describe, expect, it } from 'vitest';
import {
  IllegalAction,
  RandomBot,
  findLeaks,
  runMatch,
  type Seat,
} from '@gametable/engine';
import { buckshot, legalActionsFor, type BuckshotState, type ItemType } from './index.js';

const seats: Seat[] = [
  { id: 's1', name: 'Ada', kind: 'bot' },
  { id: 's2', name: 'Dealer', kind: 'bot' },
];

function stateWith(patch: Partial<BuckshotState> = {}): BuckshotState {
  const base = buckshot.setup({ seed: 7, seats, options: {} });
  return { ...base, ...patch };
}

function shoot(state: BuckshotState, seat: string, target: 'self' | 'opponent') {
  return buckshot.apply(state, seat, { type: 'shoot', target });
}

describe('setup', () => {
  it('deals a legal opening position', () => {
    const state = buckshot.setup({ seed: 3, seats, options: {} });
    expect(state.round).toBe(1);
    expect(state.hp).toEqual([2, 2]);
    expect(state.items).toEqual([[], []]);
    expect(state.chamber.length).toBeGreaterThanOrEqual(4);
    expect(state.chamber.length).toBeLessThanOrEqual(8);
    expect(state.chamber.filter((s) => s === 'live').length).toBeGreaterThan(0);
    expect(state.chamber.filter((s) => s === 'blank').length).toBeGreaterThan(0);
    expect(buckshot.terminal(state)).toBe(false);
  });

  it('is deterministic for a seed', () => {
    const a = buckshot.setup({ seed: 42, seats, options: {} });
    const b = buckshot.setup({ seed: 42, seats, options: {} });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = buckshot.setup({ seed: 43, seats, options: {} });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('refuses a third seat', () => {
    expect(() =>
      buckshot.setup({
        seed: 1,
        seats: [...seats, { id: 's3', name: 'Extra', kind: 'bot' }],
        options: {},
      }),
    ).toThrow(/duel/);
  });
});

describe('shooting', () => {
  it('a blank fired at yourself keeps the turn', () => {
    const state = stateWith({ chamber: ['blank', 'live', 'blank', 'live'], turn: 0, hp: [2, 2] });
    const next = shoot(state, 's1', 'self');
    expect(next.turn).toBe(0);
    expect(next.hp).toEqual([2, 2]);
    expect(next.stats.shots).toBe(1);
    expect(next.chamber).toHaveLength(3);
  });

  it('a live shell fired at yourself costs health and the turn', () => {
    const state = stateWith({ chamber: ['live', 'blank', 'blank', 'live'], turn: 0, hp: [2, 2] });
    const next = shoot(state, 's1', 'self');
    expect(next.hp).toEqual([1, 2]);
    expect(next.turn).toBe(1);
  });

  it('shooting the opponent always passes the turn', () => {
    const state = stateWith({ chamber: ['blank', 'blank', 'live', 'live'], turn: 0, hp: [2, 2] });
    const next = shoot(state, 's1', 'opponent');
    expect(next.hp).toEqual([2, 2]);
    expect(next.turn).toBe(1);
  });

  it('a sawed barrel deals two damage', () => {
    const state = stateWith({
      chamber: ['live', 'blank', 'live', 'blank'],
      turn: 0,
      hp: [4, 4],
      sawed: true,
    });
    const next = shoot(state, 's1', 'opponent');
    expect(next.hp).toEqual([4, 2]);
    expect(next.sawed).toBe(false);
  });
});

describe('items', () => {
  function withItems(seat0: ItemType[], seat1: ItemType[] = []): BuckshotState {
    return stateWith({
      chamber: ['blank', 'live', 'blank', 'live'],
      items: [seat0, seat1],
      hp: [3, 3],
      maxHp: 4,
    });
  }

  it('cigarettes heal but cannot be used at full health', () => {
    const full = withItems(['cigarette']);
    full.hp = [4, 4];
    expect(legalActionsFor(full, 0)).not.toContainEqual({ type: 'use', item: 'cigarette' });
    const hurt = stateWith({ ...withItems(['cigarette']), hp: [2, 3] });
    const next = buckshot.apply(hurt, 's1', { type: 'use', item: 'cigarette' });
    expect(next.hp[0]).toBe(3);
    expect(next.items[0]).toEqual([]);
  });

  it('beer ejects the current shell publicly', () => {
    const state = withItems(['beer']);
    const next = buckshot.apply(state, 's1', { type: 'use', item: 'beer' });
    expect(next.chamber).toHaveLength(3);
    expect(next.log.at(-1)?.text).toMatch(/BLANK/);
    expect(next.turn).toBe(0);
  });

  it('handcuffs make the opponent skip their turn once', () => {
    const state = withItems(['handcuffs']);
    const cuffed = buckshot.apply(state, 's1', { type: 'use', item: 'handcuffs' });
    expect(cuffed.skip).toEqual([false, true]);
    const shot = shoot(cuffed, 's1', 'opponent');
    expect(shot.turn).toBe(0);
    expect(shot.skip).toEqual([false, false]);
  });

  it('the inverter flips the current shell', () => {
    const state = withItems(['inverter']);
    const before = state.chamber[0];
    const next = buckshot.apply(state, 's1', { type: 'use', item: 'inverter' });
    expect(next.chamber[0]).not.toBe(before);
  });

  it('adrenaline opens a steal phase and copies the effect', () => {
    const state = withItems(['adrenaline'], ['cigarette', 'beer']);
    state.hp = [2, 3];
    const stealing = buckshot.apply(state, 's1', { type: 'use', item: 'adrenaline' });
    expect(stealing.phase).toBe('adrenaline');
    expect(legalActionsFor(stealing, 0)).toEqual([
      { type: 'steal', item: 'cigarette' },
      { type: 'steal', item: 'beer' },
    ]);
    const used = buckshot.apply(stealing, 's1', { type: 'steal', item: 'cigarette' });
    expect(used.hp[0]).toBe(3);
    expect(used.items[1]).toEqual(['beer']);
    expect(used.phase).toBe('turn');
  });

  it('rejects items the seat does not hold', () => {
    const state = withItems([]);
    expect(() => buckshot.apply(state, 's1', { type: 'use', item: 'beer' })).toThrow(IllegalAction);
  });
});

describe('rounds and match', () => {
  it('losing a round starts the next one with more health for the loser', () => {
    const state = stateWith({
      chamber: ['live', 'blank', 'live', 'blank'],
      hp: [1, 3],
      round: 1,
      maxHp: 2,
      turn: 0,
    });
    const next = shoot(state, 's1', 'self');
    expect(next.round).toBe(2);
    expect(next.hp).toEqual([4, 4]);
    expect(next.roundWins).toEqual([0, 1]);
    expect(next.turn).toBe(0);
    expect(next.over).toBe(false);
  });

  it('ends the match at two round wins', () => {
    const state = stateWith({
      chamber: ['live', 'live', 'blank', 'blank'],
      hp: [3, 1],
      round: 2,
      roundWins: [1, 0],
      turn: 0,
    });
    const next = shoot(state, 's1', 'opponent');
    expect(next.over).toBe(true);
    expect(buckshot.terminal(next)).toBe(true);
    expect(buckshot.scoring(next).winners).toEqual(['s1']);
  });

  it('plays to completion with random bots', async () => {
    const bots = new Map([
      ['s1', new RandomBot(1)],
      ['s2', new RandomBot(2)],
    ]);
    const result = await runMatch(buckshot, seats, bots, { seed: 11, maxActions: 400 });
    expect(result.winners).toHaveLength(1);
    expect(result.events.length).toBeGreaterThan(3);
  });
});

describe('knowledge and leaks', () => {
  it('hides the chamber order and the opponent items', () => {
    const state = stateWith({
      chamber: ['live', 'blank', 'live', 'blank'],
      items: [['beer'], ['handcuffs', 'pills']],
      turn: 0,
    });
    const leaks = findLeaks(buckshot, state, ['s1', 's2']);
    expect(leaks).toEqual([]);
  });

  it('a magnifier shows the shell only to the seat that used it', () => {
    const state = stateWith({ chamber: ['live', 'blank', 'live', 'blank'], items: [['magnifier'], []] });
    const next = buckshot.apply(state, 's1', { type: 'use', item: 'magnifier' });
    const mine = buckshot.view(next, 's1').data as { youPeeked: { top: string | null } };
    const theirs = buckshot.view(next, 's2').data as { youPeeked: { top: string | null } };
    expect(mine.youPeeked.top).toBe('live');
    expect(theirs.youPeeked.top).toBeNull();
    expect(JSON.stringify(buckshot.view(next, 's2'))).not.toContain('#hidden');
  });
});
