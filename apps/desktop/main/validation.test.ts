import { describe, expect, it } from 'vitest';
import { BadRequest, validateArena, validateConfig, validateStartRequest } from './validation.js';

const seat = { name: 'Seat 1', kind: 'llm', modelId: 'deepseek/x' };

describe('IPC validation', () => {
  it('accepts a well-formed match request', () => {
    const request = validateStartRequest({
      gameId: 'mafia',
      seats: [seat, { name: 'You', kind: 'human' }],
      budgetUsd: 2,
      speed: 1,
      seed: 42,
    });
    expect(request.gameId).toBe('mafia');
    expect(request.seats).toHaveLength(2);
  });

  it('passes a valid voice through and rejects impossible speakers', () => {
    const valid = validateStartRequest({
      gameId: 'mafia',
      seats: [{ ...seat, voice: 318 }],
      budgetUsd: 1,
    });
    expect(valid.seats[0]?.voice).toBe(318);
    expect(() =>
      validateStartRequest({ gameId: 'mafia', seats: [{ ...seat, voice: 9999 }], budgetUsd: 1 }),
    ).toThrow(/voice/);
  });

  it('rejects unknown seat kinds and AI seats without a model', () => {
    expect(() =>
      validateStartRequest({ gameId: 'mafia', seats: [{ name: 'x', kind: 'robot' }], budgetUsd: 1 }),
    ).toThrow(BadRequest);
    expect(() =>
      validateStartRequest({ gameId: 'mafia', seats: [{ name: 'x', kind: 'llm' }], budgetUsd: 1 }),
    ).toThrow(/without a model/);
  });

  it('bounds seat count, budgets and speed', () => {
    expect(() => validateStartRequest({ gameId: 'mafia', seats: [], budgetUsd: 1 })).toThrow();
    expect(() =>
      validateStartRequest({ gameId: 'mafia', seats: [seat], budgetUsd: 99999 }),
    ).toThrow(/budgetUsd/);
    expect(() =>
      validateStartRequest({ gameId: 'mafia', seats: [seat], budgetUsd: 1, speed: 99 }),
    ).toThrow(/speed/);
  });

  it('validates saved config and arena settings', () => {
    expect(validateConfig({ humanName: 'You', seats: [], budgetUsd: 2, speed: 1, voice: true }).voice).toBe(true);
    expect(() => validateConfig({ seats: new Array(11).fill({ modelId: 'x' }) })).toThrow();
    expect(() =>
      validateArena({ gameId: 'buckshot', seats: [seat], matches: 500, budgetPerMatch: 1, totalBudgetUsd: 2, seedBase: 1 }),
    ).toThrow(/matches/);
  });
});
