import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { OpenRouterClient } from '@gametable/agent';
import type { GameDef, Seat } from '@gametable/engine';
import { buckshot } from '@gametable/games-buckshot';
import { mafia } from '@gametable/games-mafia';
import { ResultsStore, bradleyTerry } from '@gametable/stats';
import { SecretStore } from './secrets.js';
import { ModelCatalogCache } from './catalog.js';
import { MatchSession } from './session.js';
import { DEMO_MODELS, DemoClient } from './demo.js';
import { buildTranscript } from './transcript.js';
import { synthesize } from './tts.js';
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type AppStatus,
  type GameInfo,
  type KeyResult,
  type LeaderboardRow,
  type MatchSummary,
  type ModelCatalogResult,
  type ReplayBundle,
  type StartMatchRequest,
  type StartMatchResult,
} from '../shared/api.js';

const games: Array<GameDef<any>> = [mafia, buckshot];
const demo = process.env.GAMETABLE_DEMO === '1';

export function registerIpc(userDataDir: string, getWindow: () => BrowserWindow | null): void {
  const secrets = new SecretStore(join(userDataDir, 'secrets.json'));
  const catalog = new ModelCatalogCache(join(userDataDir, 'models.json'));
  const configFile = join(userDataDir, 'config.json');
  const results = new ResultsStore(join(userDataDir, 'results.jsonl'));
  const matchesDir = join(userDataDir, 'matches');

  let current: MatchSession | null = null;

  ipcMain.handle('app:status', async (): Promise<AppStatus> => {
    const key = await secrets.getKey();
    let keyInfo = null;
    if (key) {
      try {
        keyInfo = await new OpenRouterClient({ apiKey: key }).checkKey();
      } catch {
        keyInfo = null;
      }
    }
    if (demo) {
      return {
        version: process.env.npm_package_version ?? '0.1.0',
        hasKey: true,
        keyValid: true,
        keyInfo: { label: 'demo key', usage: 0.42, limit: 5, isFreeTier: false },
        storage: 'file',
      };
    }
    return {
      version: process.env.npm_package_version ?? '0.1.0',
      hasKey: key !== null,
      keyValid: keyInfo !== null,
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
    if (demo) return { models: DEMO_MODELS, fetchedAt: Date.now(), fromCache: false };
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
    await mkdir(join(configFile, '..'), { recursive: true });
    await writeFile(configFile, JSON.stringify(value, null, 2), 'utf8');
  });

  ipcMain.handle('games:list', async (): Promise<GameInfo[]> =>
    games.map((def) => ({
      id: def.id,
      name: def.name,
      minSeats: def.minSeats,
      maxSeats: def.maxSeats,
      capabilities: def.capabilities,
    })),
  );

  ipcMain.handle('match:start', async (_event, raw: unknown): Promise<StartMatchResult> => {
    const request = raw as StartMatchRequest;
    const def = games.find((game) => game.id === request.gameId);
    if (!def) return { ok: false, error: `unknown game: ${request.gameId}` };

    const humans = request.seats.filter((seat) => seat.kind === 'human').length;
    if (humans > 1) return { ok: false, error: 'only one human seat is supported' };
    if (request.seats.length < def.minSeats || request.seats.length > def.maxSeats) {
      return {
        ok: false,
        error: `${def.name} needs ${def.minSeats}–${def.maxSeats} seats`,
      };
    }
    if (request.seats.some((seat) => seat.kind === 'llm' && !seat.modelId)) {
      return { ok: false, error: 'every AI seat needs a model' };
    }

    const key = demo ? 'demo' : await secrets.getKey();
    const needsModel = request.seats.some((seat) => seat.kind === 'llm');
    if (needsModel && !key) return { ok: false, error: 'Add an OpenRouter key first' };

    // Refuse to start a match that can only produce fallback moves.
    if (needsModel && !demo && key) {
      try {
        await new OpenRouterClient({ apiKey: key }).checkKey();
      } catch (error) {
        return { ok: false, error: `OpenRouter rejected the saved key: ${describe(error)}` };
      }
      const catalogue = await catalog.read(30 * 24 * 60 * 60 * 1000);
      if (catalogue) {
        const known = new Set(catalogue.models.map((model) => model.id));
        const missing = [
          ...new Set(
            request.seats
              .filter((seat) => seat.kind === 'llm' && seat.modelId && !known.has(seat.modelId))
              .map((seat) => seat.modelId as string),
          ),
        ];
        if (missing.length > 0) {
          return { ok: false, error: `Unknown model id: ${missing.join(', ')}` };
        }
        const unstructured = [
          ...new Set(
            request.seats
              .filter((seat) => {
                if (seat.kind !== 'llm' || !seat.modelId) return false;
                const model = catalogue.models.find((entry) => entry.id === seat.modelId);
                if (!model) return false;
                return (
                  !model.supportedParameters.includes('structured_outputs') &&
                  !model.supportedParameters.includes('response_format')
                );
              })
              .map((seat) => seat.modelId as string),
          ),
        ];
        if (unstructured.length > 0) {
          return {
            ok: false,
            error:
              `These models cannot return structured JSON, so they cannot play: ` +
              `${unstructured.join(', ')}`,
          };
        }
      }
    }

    current?.abortMatch();
    const window = getWindow();
    const seats: Seat[] = request.seats.map((seat, index) => ({
      id: `s${index + 1}`,
      name: seat.name.trim() || `Seat ${index + 1}`,
      kind: seat.kind,
      ...(seat.modelId ? { modelId: seat.modelId } : {}),
      ...(seat.persona ? { persona: seat.persona } : {}),
    }));

    const session = new MatchSession({
      def,
      seats,
      request,
      client: demo ? new DemoClient() : key ? new OpenRouterClient({ apiKey: key, appName: 'GameTable' }) : null,
      store: results,
      saveBundle: async (bundle) => {
        await mkdir(matchesDir, { recursive: true });
        await writeFile(join(matchesDir, `${bundle.summary.matchId}.json`), JSON.stringify(bundle), {
          encoding: 'utf8',
          mode: 0o600,
        });
      },
      send: (snapshot) => window?.webContents.send('match:table', snapshot),
      sendFinished: (summary) => window?.webContents.send('match:finished', summary),
      sendError: (message) => window?.webContents.send('match:error', message),
    });
    current = session;
    void session.start();
    return { ok: true, matchId: session.matchId };
  });

  ipcMain.handle('match:action', async (_event, action: unknown) => {
    current?.submit(action as never);
  });

  ipcMain.handle('match:pause', async (_event, paused: unknown) => {
    current?.setPaused(paused === true);
  });

  ipcMain.handle('match:speed', async (_event, speed: unknown) => {
    current?.setSpeed(Number(speed) || 1);
  });

  ipcMain.handle('match:abort', async () => {
    current?.abortMatch();
  });

  ipcMain.handle('matches:list', async (): Promise<MatchSummary[]> => {
    let entries: string[];
    try {
      entries = await readdir(matchesDir);
    } catch {
      return [];
    }
    const summaries: MatchSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const bundle = JSON.parse(await readFile(join(matchesDir, entry), 'utf8')) as ReplayBundle;
        if (bundle.summary) summaries.push(bundle.summary);
      } catch {
        // A corrupt replay must not hide the rest.
      }
    }
    return summaries.sort((a, b) => b.startedAt - a.startedAt);
  });

  ipcMain.handle('matches:replay', async (_event, matchId: unknown): Promise<ReplayBundle | null> => {
    if (typeof matchId !== 'string' || !/^m-[a-z0-9-]+$/i.test(matchId)) return null;
    try {
      const raw = await readFile(join(matchesDir, `${matchId}.json`), 'utf8');
      return JSON.parse(raw) as ReplayBundle;
    } catch {
      return null;
    }
  });

  ipcMain.handle('matches:export', async (_event, matchId: unknown) => {
    if (typeof matchId !== 'string') return { ok: false, error: 'invalid match' };
    let bundle: ReplayBundle;
    try {
      bundle = JSON.parse(await readFile(join(matchesDir, `${matchId}.json`), 'utf8')) as ReplayBundle;
    } catch {
      return { ok: false, error: 'that match is no longer on disk' };
    }
    const window = getWindow();
    const result = window
      ? await dialog.showSaveDialog(window, {
          title: 'Export transcript',
          defaultPath: `gametable-${bundle.summary.gameId}-${matchId}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        })
      : { canceled: true, filePath: '' };
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    await writeFile(result.filePath, buildTranscript(bundle), 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('leaderboard', async (): Promise<LeaderboardRow[]> => {
    const records = await results.all();
    return bradleyTerry(records).map((rating) => ({
      modelId: rating.modelId,
      rating: rating.rating,
      matches: rating.matches,
      wins: rating.wins,
      losses: rating.losses,
      avgCostUsd: rating.avgCostUsd,
      metrics: rating.metrics,
    }));
  });

  ipcMain.handle('tts:speak', async (_event, payload: unknown) => {
    const { text, seatId } = (payload ?? {}) as { text?: unknown; seatId?: unknown };
    if (typeof text !== 'string' || typeof seatId !== 'string') {
      return { error: 'invalid speech request' };
    }
    try {
      const audio = await synthesize(text, seatId);
      return audio ? { audio } : { error: 'nothing to say' };
    } catch (error) {
      return { error: describe(error) };
    }
  });

  ipcMain.handle('app:open-data', async () => {
    await shell.openPath(userDataDir);
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
