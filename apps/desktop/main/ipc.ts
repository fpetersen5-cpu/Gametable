import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';
import { OpenRouterClient } from '@gametable/agent';
import { SecretStore } from './secrets.js';
import { ModelCatalogCache } from './catalog.js';
import { DEFAULT_CONFIG, type AppConfig, type AppStatus, type KeyResult, type ModelCatalogResult } from '../shared/api.js';

export function registerIpc(userDataDir: string): void {
  const secrets = new SecretStore(join(userDataDir, 'secrets.json'));
  const catalog = new ModelCatalogCache(join(userDataDir, 'models.json'));
  const configFile = join(userDataDir, 'config.json');

  ipcMain.handle('app:status', async (): Promise<AppStatus> => {
    const key = await secrets.getKey();
    let keyInfo = null;
    if (key) {
      try {
        keyInfo = await new OpenRouterClient({ apiKey: key }).checkKey();
      } catch {
        keyInfo = null; // stale or revoked key: show it as unconfigured
      }
    }
    return {
      version: process.env.npm_package_version ?? '0.1.0',
      hasKey: key !== null,
      keyInfo,
      storage: 'file',
    };
  });

  ipcMain.handle('key:set', async (_event, rawKey: unknown): Promise<KeyResult> => {
    if (typeof rawKey !== 'string') return { ok: false, error: 'Key must be a string' };
    const key = rawKey.trim();
    if (!key.startsWith('sk-or-')) {
      return { ok: false, error: 'OpenRouter keys start with sk-or-' };
    }
    try {
      const client = new OpenRouterClient({ apiKey: key });
      const keyInfo = await client.checkKey();
      await secrets.setKey(key);
      return { ok: true, keyInfo };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  });

  ipcMain.handle('key:clear', async () => {
    await secrets.clear();
  });

  ipcMain.handle('models:list', async (_event, refresh: unknown): Promise<ModelCatalogResult> => {
    const key = await secrets.getKey();
    const force = refresh === true;
    if (!force) {
      const cached = await catalog.read();
      if (cached) return { models: cached.models, fetchedAt: cached.fetchedAt, fromCache: true };
    }
    if (!key) throw new Error('Add an OpenRouter key first');
    const models = await new OpenRouterClient({ apiKey: key }).listModels();
    const fetchedAt = Date.now();
    await catalog.write({ fetchedAt, models });
    return { models, fetchedAt, fromCache: false };
  });

  ipcMain.handle('config:load', async (): Promise<AppConfig> => {
    try {
      const parsed = JSON.parse(await readFile(configFile, 'utf8')) as Partial<AppConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return DEFAULT_CONFIG;
    }
  });

  ipcMain.handle('config:save', async (_event, config: unknown) => {
    const value = config as AppConfig;
    if (!value || typeof value !== 'object' || !Array.isArray(value.seats)) {
      throw new Error('invalid config');
    }
    if (value.seats.length > 10) throw new Error('at most 10 AI seats');
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify(value, null, 2), 'utf8');
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('401')) return 'OpenRouter rejected that key';
    if (error.message.includes('429')) return 'Rate limited — try again in a moment';
    if (error.message.toLowerCase().includes('fetch')) return 'Could not reach openrouter.ai';
    return error.message.slice(0, 200);
  }
  return 'Unknown error';
}
