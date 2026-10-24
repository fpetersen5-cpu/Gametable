import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MatchRecord, ResultsStore } from '@gametable/stats';
import {
  BACKUP_FORMAT_VERSION,
  REPLAY_FORMAT_VERSION,
  type AppConfig,
  type BackupBundle,
  type ReplayBundle,
} from '../shared/api.js';
import { validateConfig } from './validation.js';
import { secureWrite } from './secure-file.js';

/** Replays and backups contain hidden roles and private chat; cap import size. */
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_MATCHES = 10_000;
const MAX_RESULTS = 100_000;
const MAX_EVENTS = 20_000;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupError('Backup contains a malformed object');
  }
  return value as Record<string, unknown>;
}

function matchId(value: unknown): string {
  if (typeof value !== 'string' || !/^[am]-[a-z0-9-]+$/i.test(value)) {
    throw new BackupError('Backup contains an unsafe match ID');
  }
  return value;
}

export function validateReplayBundle(raw: unknown): ReplayBundle {
  const value = object(raw);
  const version = value.formatVersion;
  if (version !== undefined) {
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new BackupError('Replay has an invalid format version');
    }
    if ((version as number) > REPLAY_FORMAT_VERSION) {
      throw new BackupError(
        `Replay format ${String(version)} is newer than this app supports (${REPLAY_FORMAT_VERSION})`,
      );
    }
  }
  const summary = object(value.summary);
  matchId(summary.matchId);
  if (!isText(summary.gameId) || !isText(summary.gameName)) {
    throw new BackupError('Replay summary is incomplete');
  }
  if (!Array.isArray(value.seats) || !Array.isArray(value.events)) {
    throw new BackupError('Replay is missing seats or events');
  }
  if (!Array.isArray(value.views) || !Array.isArray(value.godViews)) {
    throw new BackupError('Replay is missing projections');
  }
  if (value.events.length > MAX_EVENTS) throw new BackupError('Replay has too many events');
  if (typeof value.seed !== 'number' || !Number.isFinite(value.seed)) {
    throw new BackupError('Replay has an invalid seed');
  }
  if (!Array.isArray(summary.seats)) throw new BackupError('Replay has no seat summaries');
  return value as unknown as ReplayBundle;
}

function validateResult(raw: unknown): MatchRecord {
  const value = object(raw);
  matchId(value.matchId);
  if (!isText(value.gameId) || !Array.isArray(value.seats)) {
    throw new BackupError('Backup contains a malformed result record');
  }
  return value as unknown as MatchRecord;
}

/** Validate an untrusted backup before any file is written. */
export function validateBackup(raw: unknown): BackupBundle {
  const value = object(raw);
  if (value.format !== 'gametable-backup') throw new BackupError('That is not a GameTable backup');
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `Backup format ${String(value.formatVersion)} is not supported (expected ${BACKUP_FORMAT_VERSION})`,
    );
  }
  if (typeof value.appVersion !== 'string' || typeof value.exportedAt !== 'number') {
    throw new BackupError('Backup metadata is incomplete');
  }
  if (!Array.isArray(value.results) || value.results.length > MAX_RESULTS) {
    throw new BackupError('Backup has an invalid results list');
  }
  if (!Array.isArray(value.matches) || value.matches.length > MAX_MATCHES) {
    throw new BackupError('Backup has an invalid replay list');
  }
  const config = validateConfig(value.config);
  const results = value.results.map(validateResult);
  const matches = value.matches.map(validateReplayBundle);
  return {
    format: 'gametable-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: value.appVersion.slice(0, 64),
    exportedAt: value.exportedAt,
    config,
    results,
    matches,
  };
}

export function createBackup(
  config: AppConfig,
  results: MatchRecord[],
  matches: ReplayBundle[],
  appVersion: string,
): BackupBundle {
  return {
    format: 'gametable-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: appVersion.slice(0, 64),
    exportedAt: Date.now(),
    config,
    results,
    matches,
  };
}

export async function readBackup(file: string): Promise<BackupBundle> {
  const info = await stat(file);
  if (!info.isFile()) throw new BackupError('That path is not a file');
  if (info.size > MAX_BACKUP_BYTES) throw new BackupError('That backup is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new BackupError('That backup is not valid JSON');
  }
  return validateBackup(parsed);
}

export interface ImportCounts {
  importedMatches: number;
  skippedMatches: number;
  importedResults: number;
  legacyMatches: number;
}

/** Merge records without overwriting anything that already exists. */
export async function mergeBackup(
  bundle: BackupBundle,
  options: {
    matchesDir: string;
    configFile: string;
    store: ResultsStore;
    restoreConfig: boolean;
  },
): Promise<ImportCounts> {
  let existingFiles: string[];
  try {
    existingFiles = await readdir(options.matchesDir);
  } catch {
    existingFiles = [];
  }
  const existingMatchFiles = new Set(
    existingFiles.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)),
  );
  const existingResults = new Set((await options.store.all()).map((record) => record.matchId));
  const seenMatches = new Set<string>();
  const newResults: MatchRecord[] = [];
  let importedMatches = 0;
  let skippedMatches = 0;
  let legacyMatches = 0;

  for (const replay of bundle.matches) {
    const id = matchId(replay.summary.matchId);
    if (seenMatches.has(id) || existingMatchFiles.has(id)) {
      skippedMatches += 1;
      continue;
    }
    seenMatches.add(id);
    if (!replay.formatVersion || replay.formatVersion < REPLAY_FORMAT_VERSION) {
      legacyMatches += 1;
    }
    await secureWrite(join(options.matchesDir, `${id}.json`), JSON.stringify(replay));
    existingMatchFiles.add(id);
    importedMatches += 1;
  }

  for (const record of bundle.results) {
    if (existingResults.has(record.matchId)) continue;
    existingResults.add(record.matchId);
    newResults.push(record);
  }
  await options.store.appendMany(newResults);

  if (options.restoreConfig) {
    await secureWrite(options.configFile, JSON.stringify(bundle.config, null, 2));
  }

  return {
    importedMatches,
    skippedMatches,
    importedResults: newResults.length,
    legacyMatches,
  };
}
