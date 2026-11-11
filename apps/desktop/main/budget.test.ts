import { describe, expect, it, vi } from 'vitest';
import type { CompletionResult } from '@gametable/agent';
import { Budget } from './arena.js';
import { BudgetExceeded } from './budget.js';

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

  it('settles an in-flight charge before admitting another seat', async () => {
    const budget = new Budget(0.125);
    let finish!: (result: CompletionResult) => void;
    const first = budget.client({ complete: () => new Promise((resolve) => { finish = resolve; }) });
    const secondCall = vi.fn();
    const second = budget.client({ complete: secondCall });
    const firstResult = first.complete({ model: 'one', messages: [] });
    const secondResult = second.complete({ model: 'two', messages: [] });
    const refused = expect(secondResult).rejects.toBeInstanceOf(BudgetExceeded);
    await Promise.resolve();
    expect(secondCall).not.toHaveBeenCalled();
    finish({ text: '{}', model: 'one', usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.125 }, latencyMs: 1 });
    await firstResult;
    await refused;
    expect(secondCall).not.toHaveBeenCalled();
    expect(budget.spentUsd).toBe(0.125);
  });
});
