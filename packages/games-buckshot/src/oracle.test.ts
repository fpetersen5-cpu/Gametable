import { describe, expect, it } from 'vitest';
import { evaluate, type OracleInput } from './oracle.js';
import { ITEM_ORDER, type ItemType } from './buckshot.js';

function belt(...items: ItemType[]): Record<ItemType, number> {
  const out = Object.fromEntries(ITEM_ORDER.map((item) => [item, 0])) as Record<ItemType, number>;
  for (const item of items) out[item] += 1;
  return out;
}

function input(patch: Partial<OracleInput> = {}): OracleInput {
  return {
    hp: [2, 2],
    maxHp: 4,
    live: 1,
    blank: 1,
    turn: 0,
    items: [belt(), belt()],
    sawed: false,
    skip: [false, false],
    ...patch,
  };
}

describe('oracle', () => {
  it('takes a guaranteed kill', () => {
    const result = evaluate(input({ hp: [2, 1], live: 1, blank: 0 }));
    expect(result.byAction.get('shoot:opponent')).toBe(1);
    expect(result.best).toBe(1);
  });

  it('prefers shooting yourself when the shell is known blank', () => {
    // With 0 live shells every shot is a blank; shooting yourself keeps control.
    const result = evaluate(input({ live: 0, blank: 4, hp: [2, 2] }));
    expect(result.byAction.get('shoot:self')).toBeGreaterThanOrEqual(
      result.byAction.get('shoot:opponent') ?? 1,
    );
  });

  it('does not offer useless items', () => {
    const result = evaluate(input({ items: [belt('cigarette'), belt()], hp: [4, 4], maxHp: 4 }));
    expect(result.byAction.has('use:cigarette')).toBe(false);
  });

  it('values information: a magnifier never hurts', () => {
    const without = evaluate(input());
    const withGlass = evaluate(input({ items: [belt('magnifier'), belt()] }));
    expect(withGlass.byAction.get('use:magnifier')).toBeGreaterThanOrEqual(without.best - 1e-9);
  });

  it('knows that a sawed shot is worth more', () => {
    const plain = evaluate(input({ hp: [4, 2], live: 1, blank: 0 }));
    const sawed = evaluate(input({ hp: [4, 2], live: 1, blank: 0, sawed: true }));
    expect(sawed.byAction.get('shoot:opponent')).toBe(1);
    expect(plain.byAction.get('shoot:opponent')).toBeLessThan(1);
    expect(sawed.best).toBeGreaterThan(plain.best);
  });

  it('respects the state budget', () => {
    const result = evaluate(input({ items: [belt('beer', 'magnifier', 'pills'), belt('handsaw')] }), 50);
    expect(result.states).toBeLessThanOrEqual(50);
  });

  it('solves a realistic mid-game position quickly', () => {
    const started = Date.now();
    const result = evaluate(
      input({
        hp: [3, 2],
        live: 2,
        blank: 2,
        items: [belt('beer', 'magnifier', 'handcuffs'), belt('cigarette', 'inverter')],
      }),
    );
    const elapsed = Date.now() - started;
    expect(result.best).toBeGreaterThan(0);
    expect(result.best).toBeLessThan(1);
    expect(elapsed).toBeLessThan(2_000);
  });
});
