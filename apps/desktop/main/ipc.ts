import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, ipcMain, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  OpenAICompatibleClient,
  OpenRouterClient,
  Semaphore,
  listLocalModels,
  probeModel,
  type CompletionClient,
  type KeyInfo,
  type ModelInfo,
} from '@gametable/agent';
import type { GameDef, MatchEvent, Seat } from '@gametable/engine';
import { buckshot } from '@gametable/games-buckshot';
import { coup } from '@gametable/games-coup';
import { mafia } from '@gametable/games-mafia';
import { ResultsStore, bradleyTerry, tableWeight } from '@gametable/stats';
import { SecretStore } from './secrets.js';
import { secureWrite, readJsonFile } from './secure-file.js';
import {
  validateArena,
  validateConfig,
  validateLocalEndpoint,
  validateSeatTests,
  validateStartRequest,
  validateTranscriptPerspective,
  BadRequest,
} from './validation.js';
import { redact } from '@gametable/agent';
import { ModelCatalogCache } from './catalog.js';
import { ModelMemoryStore } from './model-memory.js';
import { skillForGame } from './game-skills.js';
import { MatchSession } from './session.js';
import { ArenaRunner } from './arena.js';
import { DEMO_MODELS, DemoClient } from './demo.js';
import { buildTranscript } from './transcript.js';
import { synthesize, VOICE_PRESETS } from './tts.js';
import { transcribe } from './stt.js';
import { projectSeatViews, ReplayIncompatibleError } from './replay.js';
import {
  BackupError,
  createBackup,
  mergeBackup,
  readBackup,
  validateReplayBundle,
} from './backup.js';
import {
  DEFAULT_CONFIG,
  REPLAY_FORMAT_VERSION,
  type AppConfig,
  type AppStatus,
  type ArenaConfig,
  type BackupImportResult,
  type GameInfo,
  type KeyResult,
  type LeaderboardRow,
  type ModelMemorySummary,
  type MatchSummary,
  type ModelCatalogResult,
  type ReplayBundle,
  type StartMatchRequest,
  type StartMatchResult,
  type TranscriptPerspective,
} from '../shared/api.js';

const games: Array<GameDef<any>> = [mafia, buckshot, coup];
const demo = process.env.GAMETABLE_DEMO === '1';

export function registerIpc(userDataDir: string, getWindow: () => BrowserWindow | null): void {
  const secrets = new SecretStore(
    join(userDataDir, 'secrets.enc'),
    join(userDataDir, 'secrets.json'),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (encrypted) => safeStorage.decryptString(encrypted),
      backend: () => {
        try {
          return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
        } catch {
          return undefined;
        }
      },
    },
  );
  const catalog = new ModelCatalogCache(join(userDataDir, 'models.json'));
  const modelMemory = new ModelMemoryStore(join(userDataDir, 'model-memory.json'));
  const configFile = join(userDataDir, 'config.json');
  const results = new ResultsStore(join(userDataDir, 'results.jsonl'));
  const matchesDir = join(userDataDir, 'matches');
  const liveDir = join(userDataDir, 'live');

  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const window = getWindow();
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
  };

  /** Every IPC entry point accepts only the app's own renderer. */
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('untrusted IPC sender');
      return listener(event, ...args);
    });
  };

  let current: MatchSession | null = null;
  let launchGeneration = 0;
  let keyStatus: { key: string; at: number; info: KeyInfo | null } | null = null;
  const sendForSession = (session: MatchSession, channel: string, payload: unknown): void => {
    if (current !== session) return;
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  let arenaClient: CompletionClient | null = null;
  const arena = new ArenaRunner({
    games,
    client: {
      complete: (request) => {
        if (!arenaClient) return Promise.reject(new Error('No OpenRouter key is configured.'));
        return arenaClient.complete(request);
      },
    },
    store: results,
    saveBundle: async (bundle) => {
      await secureWrite(join(matchesDir, `${bundle.summary.matchId}.json`), JSON.stringify(bundle));
    },
    emit: (progress) => getWindow()?.webContents.send('arena:progress', progress),
  });

  handle('app:status', async (): Promise<AppStatus> => {
    if (demo) {
      return {
        version: process.env.npm_package_version ?? '0.2.0',
        hasKey: true,
        keyValid: true,
        keyInfo: { label: 'demo key', usage: 0.42, limit: 5, isFreeTier: false },
        storage: 'file',
      };
    }
    const key = await secrets.getKey();
    let keyInfo = null;
    if (key) {
      if (keyStatus && keyStatus.key === key && Date.now() - keyStatus.at < 60_000) {
        keyInfo = keyStatus.info;
      } else {
        try {
          keyInfo = await new OpenRouterClient({ apiKey: key }).checkKey();
        } catch {
          keyInfo = null;
        }
        keyStatus = { key, at: Date.now(), info: keyInfo };
      }
    }
    return {
      version: process.env.npm_package_version ?? '0.2.0',
      hasKey: key !== null,
      keyValid: keyInfo !== null,
      keyInfo,
      storage: await secrets.storageKind(),
    };
  });

  handle('key:set', async (_event, rawKey: unknown): Promise<KeyResult> => {
    if (typeof rawKey !== 'string') return { ok: false, error: 'Key must be a string' };
    const key = rawKey.trim();
    if (!key.startsWith('sk-or-')) {
      return { ok: false, error: 'OpenRouter keys start with sk-or-' };
    }
    if (key.length < 20 || key.length > 200) {
      return { ok: false, error: 'That does not look like an OpenRouter key' };
    }
    try {
      const client = new OpenRouterClient({ apiKey: key });
      const keyInfo = await client.checkKey();
      await secrets.setKey(key);
      keyStatus = { key, at: Date.now(), info: keyInfo };
      return { ok: true, keyInfo };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  });

  handle('key:clear', async () => {
    await secrets.clear();
    keyStatus = null;
  });

  handle('models:list', async (_event, refresh: unknown): Promise<ModelCatalogResult> => {
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

  handle('models:local', async (_event, raw: unknown) => {
    try {
      const baseUrl = validateLocalEndpoint(raw);
      return { models: await listLocalModels(baseUrl) };
    } catch (error) {
      return {
        models: [],
        error: redact(error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }
  });

  handle('seats:test', async (_event, raw: unknown) => {
    let seats;
    try {
      seats = validateSeatTests(raw);
    } catch (error) {
      return [{ name: 'Seat', modelId: '', ok: false, latencyMs: 0, costUsd: 0, structured: false,
        kind: 'unknown' as const, message: error instanceof Error ? error.message : 'invalid request' }];
    }
    if (demo) {
      return seats.map((seat) => ({
        name: seat.name, modelId: seat.modelId, ok: true, latencyMs: 1,
        costUsd: 0, structured: true,
      }));
    }
    const key = await secrets.getKey();
    const openRouter = key ? new OpenRouterClient({ apiKey: key, appName: 'GameTable probe' }) : null;
    const locals = new Map<string, OpenAICompatibleClient>();
    const semaphore = new Semaphore(4);
    return Promise.all(
      seats.map(async (seat) => {
        let client: CompletionClient | null = openRouter;
        if (seat.provider === 'local') {
          const baseUrl = seat.baseUrl ?? DEFAULT_CONFIG.localEndpoint;
          client = locals.get(baseUrl) ?? new OpenAICompatibleClient({ baseUrl });
          locals.set(baseUrl, client as OpenAICompatibleClient);
        }
        if (!client) {
          return {
            name: seat.name, modelId: seat.modelId, ok: false, latencyMs: 0,
            costUsd: 0, structured: false, kind: 'auth' as const,
            message: 'Add an OpenRouter key in Settings, or use a local seat.',
          };
        }
        const result = await semaphore.run(() => probeModel(client as CompletionClient, seat.modelId));
        return {
          name: seat.name,
          modelId: seat.modelId,
          ...result,
        };
      }),
    );
  });

  handle('config:load', async (): Promise<AppConfig> => {
    let raw: string;
    try {
      raw = await readFile(configFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
      return validateConfig({ ...DEFAULT_CONFIG, ...parsed });
    } catch {
      throw new Error('Saved settings are invalid. Open the data folder and repair or rename config.json, then retry.');
    }
  });

  handle('config:save', async (_event, config: unknown) => {
    const value = validateConfig(config);
    await secureWrite(configFile, JSON.stringify(value, null, 2));
  });

  handle('games:list', async (): Promise<GameInfo[]> =>
    games.map((def) => ({
      id: def.id,
      name: def.name,
      minSeats: def.minSeats,
      maxSeats: def.maxSeats,
      capabilities: def.capabilities,
    })),
  );

  handle('match:start', async (_event, raw: unknown): Promise<StartMatchResult> => {
    let request: StartMatchRequest;
    try {
      request = validateStartRequest(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'invalid match request' };
    }
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

    const llmSeats = request.seats.filter((seat) => seat.kind === 'llm');
    const needsOpenRouter = llmSeats.some((seat) => seat.provider !== 'local');
    const generation = ++launchGeneration;
    const key = demo ? 'demo' : await secrets.getKey();
    if (needsOpenRouter && !key) return { ok: false, error: 'Add an OpenRouter key first' };

    // Refuse to start an OpenRouter match that can only produce fallback moves.
    if (needsOpenRouter && !demo && key) {
      try {
        await new OpenRouterClient({ apiKey: key }).checkKey();
      } catch (error) {
        return { ok: false, error: `OpenRouter rejected the saved key: ${describe(error)}` };
      }
      const catalogue = await catalog.read(30 * 24 * 60 * 60 * 1000);
      if (catalogue) {
        const remote = request.seats.filter(
          (seat) => seat.kind === 'llm' && seat.provider !== 'local',
        );
        const known = new Set(catalogue.models.map((model) => model.id));
        const missing = [
          ...new Set(
            remote
              .filter((seat) => seat.modelId && !known.has(seat.modelId))
              .map((seat) => seat.modelId as string),
          ),
        ];
        if (missing.length > 0) {
          return { ok: false, error: `Unknown model id: ${missing.join(', ')}` };
        }
        const unstructured = [
          ...new Set(
            remote
              .filter((seat) => {
                if (!seat.modelId) return false;
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

    const seats: Seat[] = request.seats.map((seat, index) => ({
      id: `s${index + 1}`,
      name: seat.name.trim() || `Seat ${index + 1}`,
      kind: seat.kind,
      ...(seat.modelId ? { modelId: seat.modelId } : {}),
      ...(seat.persona ? { persona: seat.persona } : {}),
      ...(seat.budgetUsd === undefined ? {} : { budgetUsd: seat.budgetUsd }),
    }));

    const catalogue = await catalog.read(30 * 24 * 60 * 60 * 1000);
    if (generation !== launchGeneration) return { ok: false, error: 'Match launch cancelled.' };
    const providers = createMatchProviders(request, seats, key, catalogue?.models ?? []);
    await modelMemory.ready;

    const session: MatchSession = new MatchSession({
      def,
      seats,
      request,
      ...providers,
      memory: {
        read: (key) => modelMemory.get(key),
        save: (key, notes) => modelMemory.set(key, notes),
      },
      skill: skillForGame(def.id),
      store: results,
      saveBundle: async (bundle) => {
        await secureWrite(join(matchesDir, `${bundle.summary.matchId}.json`), JSON.stringify(bundle));
      },
      send: (snapshot) => sendForSession(session, 'match:table', snapshot),
      sendPreview: (seatId, text) => {
        if (process.env.GAMETABLE_DEBUG_STREAM === '1') {
          console.info('[preview]', seatId, text.length);
        }
        sendForSession(session, 'match:preview', { seatId, text });
      },
      sendFinished: (summary) => sendForSession(session, 'match:finished', summary),
      sendError: (message) => sendForSession(session, 'match:error', message),
      sendDebrief: (debrief) => sendForSession(session, 'match:debrief', debrief),
      saveLive: async (snapshot) => {
        await secureWrite(
          join(liveDir, `${snapshot.matchId}.json`),
          JSON.stringify({ ...snapshot, updatedAt: Date.now() }),
        );
      },
      clearLive: async (matchId) => {
        await rm(join(liveDir, `${matchId}.json`), { force: true });
      },
      saveDebrief: async (matchId, debrief) => {
        const file = join(matchesDir, `${matchId}.json`);
        try {
          const bundle = JSON.parse(await readFile(file, 'utf8')) as ReplayBundle;
          bundle.debrief = debrief;
          await secureWrite(file, JSON.stringify(bundle));
        } catch {
          // The debrief is a bonus; a missing bundle is not worth failing.
        }
      },
    });
    const previous = current;
    current = session;
    previous?.abortMatch();
    void session.start();
    return { ok: true, matchId: session.matchId };
  });

  handle('match:action', async (_event, action: unknown) => {
    if (typeof action !== 'object' || action === null) return;
    const type = (action as { type?: unknown }).type;
    if (typeof type !== 'string' || type.length > 64) return;
    let size: number;
    try {
      size = JSON.stringify(action).length;
    } catch {
      return;
    }
    if (size > 4000) return;
    current?.submit(action as never);
  });

  handle('match:pause', async (_event, paused: unknown) => {
    current?.setPaused(paused === true);
  });

  handle('match:speed', async (_event, speed: unknown) => {
    const value = Number(speed);
    if (!Number.isFinite(value)) return;
    current?.setSpeed(Math.min(8, Math.max(0.5, value)));
  });

  handle('match:abort', async () => {
    ++launchGeneration;
    current?.abortMatch();
  });

  handle('match:rewind', async () => {
    await current?.rewind(1);
  });

  handle('match:retry-save', async (_event, matchId: unknown) => {
    if (typeof matchId !== 'string' || !current || current.matchId !== matchId) {
      return { ok: false, error: 'That match is no longer open. Resume it from the table to recover it.' };
    }
    return current.retrySave();
  });

  handle('match:takeover', async (_event, seatId: unknown) => {
    if (typeof seatId === 'string' && seatId.length <= 64) current?.takeover(seatId);
  });

  handle('match:release', async (_event, seatId: unknown) => {
    if (typeof seatId === 'string' && seatId.length <= 64) current?.release(seatId);
  });

  handle('arena:start', async (_event, raw: unknown) => {
    let config: ArenaConfig;
    try {
      config = validateArena(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'invalid arena config' };
    }
    const key = demo ? 'demo' : await secrets.getKey();
    if (!key) return { ok: false, error: 'Add an OpenRouter key first' };
    arenaClient = demo
      ? new DemoClient()
      : new OpenRouterClient({ apiKey: key, appName: 'GameTable Arena' });
    return arena.start(config);
  });

  handle('arena:pause', async (_event, paused: unknown) => {
    arena.pause(paused === true);
  });

  handle('arena:cancel', async () => {
    arena.cancel();
  });

  handle('arena:state', async () => arena.state());

  handle('matches:resumable', async () => {
    let entries: string[];
    try {
      entries = await readdir(liveDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: Array<{
      matchId: string;
      gameId: string;
      gameName: string;
      eventCount: number;
      updatedAt: number;
      seats: Array<{ name: string; modelId?: string }>;
    }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const saved = JSON.parse(await readFile(join(liveDir, entry), 'utf8')) as {
          matchId: string;
          gameId: string;
          gameName: string;
          events?: unknown[];
          updatedAt?: number;
          request?: { seats?: Array<{ name: string; modelId?: string }> };
        };
        if (!saved.matchId) continue;
        out.push({
          matchId: saved.matchId,
          gameId: saved.gameId,
          gameName: saved.gameName,
          eventCount: saved.events?.length ?? 0,
          updatedAt: saved.updatedAt ?? 0,
          seats: (saved.request?.seats ?? []).map((seat) => ({
            name: seat.name,
            ...(seat.modelId ? { modelId: seat.modelId } : {}),
          })),
        });
      } catch {
        // ignore unreadable live files
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  handle('match:resume', async (_event, matchId: unknown): Promise<StartMatchResult> => {
    if (typeof matchId !== 'string' || !/^[am]-[a-z0-9-]+$/i.test(matchId)) {
      return { ok: false, error: 'invalid match' };
    }
    const generation = ++launchGeneration;
    let saved: {
      matchId: string;
      gameId: string;
      request: StartMatchRequest;
      seats: Seat[];
      seed: number;
      spentUsd?: number;
      state: unknown;
      events: MatchEvent[];
      controllers?: Record<string, unknown>;
    };
    try {
      saved = JSON.parse(await readFile(join(liveDir, `${matchId}.json`), 'utf8')) as typeof saved;
    } catch {
      return { ok: false, error: 'That match is no longer resumable.' };
    }
    const def = games.find((game) => game.id === saved.gameId);
    if (!def) return { ok: false, error: `unknown game: ${saved.gameId}` };
    if (
      !saved.request ||
      !Array.isArray(saved.request.seats) ||
      !Array.isArray(saved.seats) ||
      saved.seats.length === 0 ||
      !Array.isArray(saved.events)
    ) {
      return { ok: false, error: 'That saved match is incomplete or corrupt.' };
    }
    if (
      saved.controllers !== undefined &&
      (typeof saved.controllers !== 'object' ||
        saved.controllers === null ||
        Array.isArray(saved.controllers))
    ) {
      return { ok: false, error: 'That saved match has invalid seat memory.' };
    }

    const key = demo ? 'demo' : await secrets.getKey();
    const needsOpenRouter = saved.request.seats.some(
      (seat) => seat.kind === 'llm' && seat.provider !== 'local',
    );
    if (needsOpenRouter && !key) {
      return { ok: false, error: 'Add an OpenRouter key first' };
    }
    const catalogue = await catalog.read(30 * 24 * 60 * 60 * 1000);
    if (generation !== launchGeneration) return { ok: false, error: 'Match launch cancelled.' };
    const providers = createMatchProviders(saved.request, saved.seats, key, catalogue?.models ?? []);
    await modelMemory.ready;
    const session: MatchSession = new MatchSession({
      def,
      seats: saved.seats,
      request: saved.request,
      ...providers,
      memory: {
        read: (key) => modelMemory.get(key),
        save: (key, notes) => modelMemory.set(key, notes),
      },
      skill: skillForGame(def.id),
      store: results,
      matchId: saved.matchId,
      resume: {
        seed: saved.seed,
        spentUsd: saved.spentUsd,
        state: saved.state,
        events: saved.events,
        controllers: saved.controllers ?? {},
      },
      saveBundle: async (bundle) => {
        await secureWrite(join(matchesDir, `${bundle.summary.matchId}.json`), JSON.stringify(bundle));
      },
      send: (snapshot) => sendForSession(session, 'match:table', snapshot),
      sendPreview: (seatId, text) => {
        if (process.env.GAMETABLE_DEBUG_STREAM === '1') {
          console.info('[preview]', seatId, text.length);
        }
        sendForSession(session, 'match:preview', { seatId, text });
      },
      sendFinished: (summary) => sendForSession(session, 'match:finished', summary),
      sendError: (message) => sendForSession(session, 'match:error', message),
      sendDebrief: (debrief) => sendForSession(session, 'match:debrief', debrief),
      saveLive: async (snapshot) => {
        await secureWrite(
          join(liveDir, `${snapshot.matchId}.json`),
          JSON.stringify({ ...snapshot, updatedAt: Date.now() }),
        );
      },
      clearLive: async (id) => {
        await rm(join(liveDir, `${id}.json`), { force: true });
      },
      saveDebrief: async (id, debrief) => {
        try {
          const file = join(matchesDir, `${id}.json`);
          const bundle = JSON.parse(await readFile(file, 'utf8')) as ReplayBundle;
          bundle.debrief = debrief;
          await secureWrite(file, JSON.stringify(bundle));
        } catch {
          // ignore
        }
      },
    });
    const previous = current;
    current = session;
    previous?.abortMatch();
    void session.start();
    return { ok: true, matchId: session.matchId };
  });

  handle('matches:list', async (): Promise<MatchSummary[]> => {
    let entries: string[];
    try {
      entries = await readdir(matchesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
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

  handle('matches:replay', async (_event, matchId: unknown): Promise<ReplayBundle | null> => {
    if (typeof matchId !== 'string' || !/^[am]-[a-z0-9-]+$/i.test(matchId)) return null;
    try {
      const raw = await readFile(join(matchesDir, `${matchId}.json`), 'utf8');
      const bundle = JSON.parse(raw) as ReplayBundle;
      if (bundle.formatVersion && bundle.formatVersion > REPLAY_FORMAT_VERSION) return null;
      return bundle;
    } catch {
      return null;
    }
  });

  handle('replay:seat-views', async (_event, payload: unknown) => {
    const { matchId, seatId } = (payload ?? {}) as { matchId?: unknown; seatId?: unknown };
    if (typeof matchId !== 'string' || typeof seatId !== 'string') {
      return { views: null, error: 'invalid replay request' };
    }
    if (!/^[am]-[a-z0-9-]+$/i.test(matchId)) {
      return { views: null, error: 'invalid replay request' };
    }
    try {
      const bundle = JSON.parse(
        await readFile(join(matchesDir, `${matchId}.json`), 'utf8'),
      ) as ReplayBundle;
      const def = games.find((game) => game.id === bundle.summary.gameId);
      if (!def) return { views: null, error: 'that game is not installed' };
      return { views: projectSeatViews(def, bundle, seatId) };
    } catch (error) {
      if (error instanceof ReplayIncompatibleError) {
        return { views: null, error: error.message };
      }
      return { views: null, error: 'That replay could not be read.' };
    }
  });

  handle('matches:export', async (_event, matchId: unknown, rawPerspective?: unknown) => {
    if (typeof matchId !== 'string' || !/^[am]-[a-z0-9-]+$/i.test(matchId)) {
      return { ok: false, error: 'invalid match' };
    }
    let bundle: ReplayBundle;
    try {
      bundle = JSON.parse(await readFile(join(matchesDir, `${matchId}.json`), 'utf8')) as ReplayBundle;
    } catch {
      return { ok: false, error: 'that match is no longer on disk' };
    }
    let perspective: TranscriptPerspective;
    let transcript: string;
    try {
      perspective = validateTranscriptPerspective(rawPerspective);
      const def = games.find((game) => game.id === bundle.summary.gameId);
      if (!def) return { ok: false, error: 'that game is not installed' };
      transcript = buildTranscript(def, bundle, perspective);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof ReplayIncompatibleError || error instanceof BadRequest
          ? error.message : 'That transcript could not be projected safely. Nothing was exported.',
      };
    }
    const window = getWindow();
    // A compromised renderer cannot bypass this warning by calling IPC directly.
    if (perspective.mode !== 'public') {
      if (!window) return { ok: false, error: 'cancelled' };
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Export private game information?',
        message: perspective.mode === 'omniscient'
          ? 'This export reveals all hidden roles, private chat and raw actions.'
          : `This export includes ${bundle.seats.find((seat) => seat.id === perspective.seatId)!.name}’s hidden cards, private knowledge and permitted private chat.`,
        detail: 'Review this file before sharing. Public export is the safer option.',
        buttons: ['Cancel', 'Export private transcript'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmation.response !== 1) return { ok: false, error: 'cancelled' };
    }
    const label = perspective.mode === 'seat' ? `seat-${perspective.seatId}` : perspective.mode;
    const result = window
      ? await dialog.showSaveDialog(window, {
          title: `Export ${perspective.mode} transcript`,
          defaultPath: `gametable-${bundle.summary.gameId}-${matchId}-${label}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        })
      : { canceled: true, filePath: '' };
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    await writeFile(result.filePath, transcript, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path: result.filePath };
  });

  handle('data:export', async () => {
    const window = getWindow();
    if (!window) return { ok: false, error: 'No window is available' };
    let config: AppConfig;
    try {
      const stored = JSON.parse(await readFile(configFile, 'utf8')) as Partial<AppConfig>;
      config = validateConfig({ ...DEFAULT_CONFIG, ...stored });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, error: 'Settings could not be validated; fix them before exporting.' };
      }
      config = DEFAULT_CONFIG;
    }
    const resultRecords = await results.all();
    const matches: ReplayBundle[] = [];
    try {
      for (const entry of await readdir(matchesDir)) {
        if (!entry.endsWith('.json')) continue;
        try {
          const bundle = validateReplayBundle(
            JSON.parse(await readFile(join(matchesDir, entry), 'utf8')),
          );
          matches.push(bundle);
        } catch {
          // A corrupt replay must not prevent backup of the rest.
        }
      }
    } catch {
      // No matches directory yet.
    }
    const bundle = createBackup(
      config,
      resultRecords,
      matches,
      process.env.npm_package_version ?? '0.2.0',
    );
    const selected = await dialog.showSaveDialog(window, {
      title: 'Export GameTable backup',
      defaultPath: `gametable-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'GameTable backup', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: false, error: 'cancelled' };
    try {
      await secureWrite(selected.filePath, JSON.stringify(bundle));
      return { ok: true, path: selected.filePath };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  });

  handle('data:import', async (): Promise<BackupImportResult> => {
    const window = getWindow();
    if (!window) return { ok: false, error: 'No window is available' };
    const selected = await dialog.showOpenDialog(window, {
      title: 'Restore a GameTable backup',
      properties: ['openFile'],
      filters: [{ name: 'GameTable backup', extensions: ['json'] }],
    });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }
    let bundle;
    try {
      bundle = await readBackup(selected.filePaths[0] as string);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof BackupError ? error.message : 'That backup could not be read',
      };
    }
    const legacy = bundle.matches.filter(
      (match) => !match.formatVersion || match.formatVersion < REPLAY_FORMAT_VERSION,
    ).length;
    const confirm = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Restore GameTable backup',
      message: `Restore ${bundle.matches.length} replay${bundle.matches.length === 1 ? '' : 's'} and ${bundle.results.length} result${bundle.results.length === 1 ? '' : 's'}?`,
      detail: [
        `Backup from ${new Date(bundle.exportedAt).toLocaleString()} (app ${bundle.appVersion}).`,
        'Existing records with the same match ID are kept; nothing is overwritten.',
        legacy > 0
          ? `${legacy} replay${legacy === 1 ? ' is' : 's are'} legacy and may not support filtered seat views.`
          : '',
        '“Records only” keeps your current settings. “Restore records + settings” replaces them.',
      ]
        .filter(Boolean)
        .join('\n'),
      buttons: ['Cancel', 'Records only', 'Restore records + settings'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirm.response === 0) return { ok: false, error: 'cancelled' };
    const restoreConfig = confirm.response === 2;
    try {
      const counts = await mergeBackup(bundle, {
        matchesDir,
        configFile,
        store: results,
        restoreConfig,
      });
      return { ok: true, ...counts, configRestored: restoreConfig };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof BackupError ? error.message : describe(error),
      };
    }
  });

  handle('leaderboard', async (_event, filter: unknown): Promise<LeaderboardRow[]> => {
    if (filter !== undefined && (typeof filter !== 'string' || !games.some((game) => game.id === filter))) {
      throw new BadRequest('Unknown game');
    }
    const records = await results.all();
    return bradleyTerry(filter === undefined ? records : records.filter((record) => record.gameId === filter), {
      weight: tableWeight,
    }).map((rating) => ({
      modelId: rating.modelId,
      rating: rating.rating,
      matches: rating.matches,
      wins: rating.wins,
      losses: rating.losses,
      avgCostUsd: rating.avgCostUsd,
      metrics: rating.metrics,
    }));
  });

  handle('tts:voices', async () => VOICE_PRESETS);

  handle('tts:speak', async (_event, payload: unknown) => {
    const { text, seatId, voice } = (payload ?? {}) as {
      text?: unknown;
      seatId?: unknown;
      voice?: unknown;
    };
    if (
      typeof text !== 'string' ||
      typeof seatId !== 'string' ||
      text.length > 700 ||
      seatId.length > 64
    ) {
      return { error: 'invalid speech request' };
    }
    if (
      voice !== undefined &&
      (typeof voice !== 'number' || !Number.isInteger(voice) || voice < 0 || voice > 903)
    ) {
      return { error: 'invalid speech request' };
    }
    const speaker = typeof voice === 'number' ? voice : current?.voiceForSeat(seatId);
    try {
      const audio = await synthesize(text, seatId, speaker);
      return audio ? { audio } : { error: 'nothing to say' };
    } catch (error) {
      return { error: describe(error) };
    }
  });

  handle('stt:transcribe', async (_event, payload: unknown) => {
    const { audio } = (payload ?? {}) as { audio?: unknown };
    if (typeof audio !== 'string' || audio.length < 100) {
      return { error: 'That recording was too short.' };
    }
    if (audio.length > 16_000_000) {
      return { error: 'That recording is too large.' };
    }
    const key = demo ? 'demo' : await secrets.getKey();
    if (!key) return { error: 'Add an OpenRouter key first' };
    const client = demo
      ? new DemoClient()
      : new OpenRouterClient({ apiKey: key, appName: 'GameTable STT' });
    try {
      const text = await transcribe(client, audio);
      return { text };
    } catch (error) {
      return { error: describe(error) };
    }
  });

  handle('memory:list', async (): Promise<ModelMemorySummary[]> => {
    await modelMemory.ready;
    return modelMemory
      .export()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({ key: entry.key, memory: entry.memory, updatedAt: entry.updatedAt }));
  });

  handle('memory:clear', async (_event, key: unknown) => {
    if (key !== undefined && typeof key !== 'string') throw new BadRequest('memory key must be a string');
    await modelMemory.ready;
    modelMemory.clear(typeof key === 'string' ? key : undefined);
    await modelMemory.flush();
  });

  handle('app:open-data', async () => {
    await shell.openPath(userDataDir);
  });
}

/** Starting and resuming must use the same per-seat providers and debrief selection. */
function createMatchProviders(
  request: StartMatchRequest,
  seats: Seat[],
  key: string | null,
  models: ModelInfo[],
) {
  const client = demo
    ? new DemoClient()
    : key
      ? new OpenRouterClient({ apiKey: key, appName: 'GameTable' })
      : null;
  const configuredSeats = new Map(seats.map((seat, index) => [seat.id, request.seats[index]]));
  const locals = new Map<string, OpenAICompatibleClient>();
  const clientForSeat = (seat: Seat): CompletionClient | null => {
    if (demo) return client;
    const configured = configuredSeats.get(seat.id);
    if (!configured || configured.provider !== 'local') return client;
    const baseUrl = configured.baseUrl ?? DEFAULT_CONFIG.localEndpoint;
    let local = locals.get(baseUrl);
    if (!local) {
      local = new OpenAICompatibleClient({ baseUrl });
      locals.set(baseUrl, local);
    }
    return local;
  };
  const seatModels = new Set(
    request.seats
      .filter((seat) => seat.kind === 'llm' && seat.provider !== 'local' && seat.modelId)
      .map((seat) => seat.modelId as string),
  );
  const cheapest = models
    .filter((model) => seatModels.has(model.id))
    .sort((a, b) => a.promptPrice + a.completionPrice - (b.promptPrice + b.completionPrice))[0];
  return {
    client,
    clientForSeat,
    debriefModel: cheapest?.id ?? [...seatModels][0] ?? null,
  };
}

function describe(error: unknown): string {
  if (error instanceof BadRequest) return error.message;
  if (error instanceof Error) {
    if (error.message.includes('401')) return 'OpenRouter rejected that key';
    if (error.message.includes('429')) return 'Rate limited — try again in a moment';
    if (error.message.toLowerCase().includes('fetch')) return 'Could not reach openrouter.ai';
    return redact(error.message).slice(0, 200);
  }
  return 'Unknown error';
}
