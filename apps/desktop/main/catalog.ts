import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelInfo } from '@gametable/agent';

const TTL_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  fetchedAt: number;
  models: ModelInfo[];
}

/** Model catalogue cache: the list is large and changes slowly. */
export class ModelCatalogCache {
  constructor(private readonly file: string) {}

  async read(maxAgeMs = TTL_MS): Promise<CacheFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as CacheFile;
      if (!Array.isArray(parsed.models)) return null;
      if (Date.now() - parsed.fetchedAt > maxAgeMs) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async write(entry: CacheFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(entry), 'utf8');
  }
}
