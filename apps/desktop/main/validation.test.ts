import { describe, expect, it } from 'vitest';
import {
  BadRequest,
  validateArena,
  validateConfig,
  validateSeatTests,
  validateStartRequest,
} from './validation.js';

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

  it('accepts local seats and normalizes their endpoint', () => {
    const request = validateStartRequest({
      gameId: 'coup',
      seats: [{ name: 'Local', kind: 'llm', modelId: 'llama3.1:8b', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1/' }],
      budgetUsd: 1,
    });
    expect(request.seats[0]).toMatchObject({ provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(() =>
      validateStartRequest({
        gameId: 'coup',
        seats: [{ name: 'Local', kind: 'llm', modelId: 'x', provider: 'local', baseUrl: 'file:///etc/passwd' }],
        budgetUsd: 1,
      }),
    ).toThrow(BadRequest);
    expect(() =>
      validateStartRequest({
        gameId: 'coup',
        seats: [{ name: 'x', kind: 'llm', modelId: 'x', provider: 'cloud' }],
        budgetUsd: 1,
      }),
    ).toThrow(/provider/);
  });

  it('defaults local seat endpoints from config and validates probe requests', () => {
    const config = validateConfig({
      humanName: 'You',
      localEndpoint: 'http://127.0.0.1:11434/v1/',
      seats: [{ modelId: 'llama3.1:8b', provider: 'local' }],
      budgetUsd: 1,
      speed: 1,
      voice: false,
    });
    expect(config.localEndpoint).toBe('http://127.0.0.1:11434/v1');
    expect(config.seats[0]?.baseUrl).toBe(config.localEndpoint);
    expect(validateSeatTests([{ name: 'Local', modelId: 'llama3.1:8b', provider: 'local' }])[0]).toMatchObject({
      provider: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(() => validateSeatTests([])).toThrow();
  });
});
