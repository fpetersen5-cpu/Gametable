import { describe, expect, it } from 'vitest';
import { Budget } from './arena.js';

describe('arena match budget', () => {
  it('tracks remaining spend and trips exactly once at the cap', () => {
    let trips = 0;
    const budget = new Budget(0.01, () => {
      trips += 1;
    });
    expect(budget.remaining()).toBeCloseTo(0.01);
    budget.spend(0.004);
    expect(budget.remaining()).toBeCloseTo(0.006);
    budget.spend(0.01);
    expect(budget.remaining()).toBe(0);
    budget.exhausted();
    budget.exhausted();
    expect(trips).toBe(1);
    expect(budget.hitCap).toBe(true);
    expect(budget.spentUsd).toBeCloseTo(0.014);
  });

  it('ignores negative or invalid costs', () => {
    const budget = new Budget(1);
    budget.spend(-5);
    budget.spend(Number.NaN);
    expect(budget.spentUsd).toBe(0);
  });
});
