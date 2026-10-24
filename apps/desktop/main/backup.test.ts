import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResultsStore } from '@gametable/stats';
import {
  BACKUP_FORMAT_VERSION,
  DEFAULT_CONFIG,
  REPLAY_FORMAT_VERSION,
  type BackupBundle,
  type ReplayBundle,
} from '../shared/api.js';
import { createBackup, mergeBackup, readBackup, validateBackup, validateReplayBundle } from './backup.js';
import { validateConfig } from './validation.js';

function replay(id: string, version: number | undefined = REPLAY_FORMAT_VERSION): ReplayBundle {
  const view = {
    gameId: 'coup',
    seatId: 's1',
    phase: { id: 'action', label: 'Act', kind: 'sequential' as const, actor: 's1', actors: ['s1'] },
    seats: [{ id: 's1', name: 'Seat 1', kind: 'bot' as const }],
    data: {},
    briefing: '',
    chat: [],
    legalActions: [],
    terminal: true,
    winners: ['s1'],
  };
  return {
    ...(version === undefined ? {} : { formatVersion: version }),
    summary: {
      matchId: id,
      gameId: 'coup',
      gameName: 'Coup',
      startedAt: 1,
      durationMs: 1,
      winners: ['s1'],
      winnerNames: ['Seat 1'],
      seats: [{ seatId: 's1', name: 'Seat 1', kind: 'bot', costUsd: 0, tokensIn: 0, tokensOut: 0, invalidActions: 0 }],
      totalCostUsd: 0,
      eventCount: 0,
      metrics: {},
    },
    seats: [{ id: 's1', name: 'Seat 1', kind: 'bot' }],
    seed: 1,
    events: [],
    views: [view],
    godViews: [view],
  };
}

function result(id: string) {
  return {
    matchId: id,
    gameId: 'coup',
    gameVersion: '1.0.1',
    engineVersion: '1.0.0',
    seed: 1,
    startedAt: 1,
    durationMs: 1,
    seats: [],
    winnerSeats: ['s1'],
    scores: { s1: 1 },
    metrics: {},
  };
}

describe('backup and restore', () => {
  it('round-trips a validated backup and merges without overwriting records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-backup-'));
    const matchesDir = join(dir, 'matches');
    const configFile = join(dir, 'config.json');
    const store = new ResultsStore(join(dir, 'results.jsonl'));
    await store.append(result('m-existing') as never);
    await mkdir(matchesDir, { recursive: true });
    await writeFile(join(matchesDir, 'm-existing.json'), JSON.stringify(replay('m-existing')));
    const config = validateConfig({ ...DEFAULT_CONFIG, humanName: 'Restored' });
    const legacy = replay('m-legacy');
    delete legacy.formatVersion;
    const bundle = createBackup(
      config,
      [result('m-existing') as never, result('m-new') as never],
      [replay('m-existing'), legacy, replay('m-new')],
      '0.1.0',
    );
    expect(validateBackup(bundle)).toEqual(bundle);
    const path = join(dir, 'backup.json');
    await writeFile(path, JSON.stringify(bundle));
    const read = await readBackup(path);
    expect(read.matches).toHaveLength(3);
    const counts = await mergeBackup(read, { matchesDir, configFile, store, restoreConfig: true });
    expect(counts).toEqual({
      importedMatches: 2,
      skippedMatches: 1,
      importedResults: 1,
      legacyMatches: 1,
    });
    expect(await readdir(matchesDir)).toEqual(expect.arrayContaining(['m-existing.json', 'm-new.json', 'm-legacy.json']));
    expect((await store.all()).map((record) => record.matchId)).toEqual(['m-existing', 'm-new']);
    expect(JSON.parse(await readFile(configFile, 'utf8')).humanName).toBe('Restored');
    expect((await stat(join(matchesDir, 'm-new.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects future replay formats and unsafe IDs', () => {
    expect(() => validateReplayBundle(replay('m-future', REPLAY_FORMAT_VERSION + 1))).toThrow(
      /newer/,
    );
    const bad = replay('../escape');
    expect(() => validateReplayBundle(bad)).toThrow(/unsafe/);
    expect(() =>
      validateBackup({
        format: 'gametable-backup',
        formatVersion: BACKUP_FORMAT_VERSION + 1,
        appVersion: 'x',
        exportedAt: 1,
        config: DEFAULT_CONFIG,
        results: [],
        matches: [],
      }),
    ).toThrow(/not supported/);
  });
});
