import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MatchRecord } from './record.js';

/**
 * Append-only JSONL store. No native modules, no migrations, trivially
 * inspectable with `grep`. A few thousand matches is a few megabytes.
 */
export class ResultsStore {
  constructor(private readonly file: string) {}

  async append(record: MatchRecord): Promise<void> {
    await this.appendMany([record]);
  }

  /** One atomic append for imports; the caller deduplicates match IDs. */
  async appendMany(records: MatchRecord[]): Promise<void> {
    if (records.length === 0) return;
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(
      this.file,
      records.map((record) => `${JSON.stringify(record)}\n`).join(''),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  async all(): Promise<MatchRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: MatchRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as MatchRecord);
      } catch {
        // A truncated final line must not poison the whole history.
      }
    }
    return records;
  }

  async forGame(gameId: string): Promise<MatchRecord[]> {
    return (await this.all()).filter((r) => r.gameId === gameId);
  }
}
