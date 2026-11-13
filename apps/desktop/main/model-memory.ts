import { readJsonFile, secureWrite } from './secure-file.js';

const FORMAT_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_MEMORY = 4_000;

export interface ModelMemoryEntry {
  key: string;
  memory: string;
  updatedAt: number;
}

/**
 * Long-term memory for each model, keyed by provider and model identity.
 *
 * The file is private (0600) because notes can contain hidden roles, private
 * chat and seat-specific observations. Writes are serialized; a corrupt file
 * is treated as empty rather than failing the app.
 */
export class ModelMemoryStore {
  readonly ready: Promise<void>;
  private readonly entries = new Map<string, ModelMemoryEntry>();
  private saving: Promise<void> = Promise.resolve();
  private saveScheduled = false;

  constructor(private readonly file: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const raw = await readJsonFile<unknown>(this.file);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const value = raw as { version?: unknown; models?: unknown };
      if (value.version === FORMAT_VERSION && Array.isArray(value.models)) {
        for (const entry of value.models) {
          if (!entry || typeof entry !== 'object') continue;
          const saved = entry as { key?: unknown; memory?: unknown; updatedAt?: unknown };
          if (typeof saved.key !== 'string' || typeof saved.memory !== 'string') continue;
          const memory = saved.memory.trim().slice(-MAX_MEMORY);
          if (!memory) continue;
          this.entries.set(saved.key, {
            key: saved.key,
            memory,
            updatedAt:
              typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt)
                ? saved.updatedAt
                : 0,
          });
        }
      }
    }
    this.prune();
  }

  get(key: string): string {
    return this.entries.get(key)?.memory ?? '';
  }

  set(key: string, memory: string): void {
    if (!key) return;
    const clean = memory.trim().slice(-MAX_MEMORY);
    if (!clean) {
      if (!this.entries.delete(key)) return;
    } else {
      this.entries.set(key, { key, memory: clean, updatedAt: Date.now() });
    }
    this.prune();
    this.scheduleSave();
  }

  clear(key?: string): void {
    if (key) this.entries.delete(key);
    else this.entries.clear();
    this.scheduleSave();
  }

  export(): ModelMemoryEntry[] {
    return [...this.entries.values()];
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, this.entries.size - MAX_ENTRIES);
    for (const entry of oldest) this.entries.delete(entry.key);
  }

  private scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    this.saving = this.saving
      .then(async () => {
        this.saveScheduled = false;
        await secureWrite(
          this.file,
          JSON.stringify({ version: FORMAT_VERSION, models: [...this.entries.values()] }),
        );
      })
      .catch(() => undefined);
  }
}
