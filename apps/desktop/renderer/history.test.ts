import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchSummary } from '../shared/api';
import { filterMatches } from './history';
import { withTimeout } from './async';

describe('history reads', () => {
  afterEach(() => vi.useRealTimers());
  it('combines game and case-insensitive player, model, winner and ID searches', () => {
    const matches = [
      { matchId: 'm-first', gameId: 'coup', gameName: 'Coup', winnerNames: ['Ada'], seats: [{ name: 'Ada', modelId: 'vendor/clever' }] },
      { matchId: 'm-second', gameId: 'mafia', gameName: 'Mafia', winnerNames: ['Grace'], seats: [{ name: 'Ada', modelId: 'vendor/clever' }] },
    ] as MatchSummary[];
    expect(filterMatches(matches, 'coup', ' ADA clever ')).toEqual([matches[0]]);
    expect(filterMatches(matches, '', 'GRACE second')).toEqual([matches[1]]);
    expect(filterMatches(matches, 'coup', 'mafia')).toEqual([]);
    expect(filterMatches(matches, '', '  ')).toEqual(matches);
  });

  it('bounds a stalled IPC read and permits a fresh retry despite a late result', async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const old = withTimeout(new Promise<string>((resolve) => { finish = resolve; }), 'History');
    const failed = expect(old).rejects.toThrow('History timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    await expect(withTimeout(Promise.resolve('new'), 'History')).resolves.toBe('new');
    finish('old');
    await expect(old).rejects.toThrow('History timed out');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up its deadline on success and failure', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(42), 'History')).resolves.toBe(42);
    await expect(withTimeout(Promise.reject(new Error('disk unavailable')), 'History')).rejects.toThrow('disk unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
});
