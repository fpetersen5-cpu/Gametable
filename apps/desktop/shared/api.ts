import type { KeyInfo, ModelInfo, ProviderErrorKind } from '@gametable/agent';
import type { ChatLine, GameAction, GameView, MatchEvent, Phase, Seat, SeatInfo } from '@gametable/engine';
import type { MatchRecord } from '@gametable/stats';

export type {
  KeyInfo,
  ModelInfo,
  ProviderErrorKind,
  ChatLine,
  GameAction,
  GameView,
  MatchEvent,
  Phase,
  Seat,
  SeatInfo,
};

/** The renderer's entire surface. No key, no prompts, no game state beyond views. */
export interface DesktopApi {
  status(): Promise<AppStatus>;
  setKey(key: string): Promise<KeyResult>;
  clearKey(): Promise<void>;
  listModels(refresh?: boolean): Promise<ModelCatalogResult>;
  listLocalModels(baseUrl: string): Promise<LocalModelsResult>;
  /** A tiny real call per seat; advisory, before dealing. */
  testSeats(seats: SeatTestRequest[]): Promise<SeatTestResult[]>;
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;

  listGames(): Promise<GameInfo[]>;
  startMatch(request: StartMatchRequest): Promise<StartMatchResult>;
  submitAction(action: GameAction): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  abortMatch(): Promise<void>;
  rewindMatch(): Promise<void>;
  takeoverSeat(seatId: string): Promise<void>;
  releaseSeat(seatId: string): Promise<void>;
  onTable(handler: (snapshot: TableSnapshot) => void): () => void;
  onPreview(handler: (preview: SeatPreview) => void): () => void;
  onFinished(handler: (summary: MatchSummary) => void): () => void;
  onMatchError(handler: (message: string) => void): () => void;
  onDebrief(handler: (debrief: Debrief) => void): () => void;

  listMatches(): Promise<MatchSummary[]>;
  listResumable(): Promise<ResumableMatch[]>;
  resumeMatch(matchId: string): Promise<StartMatchResult>;
  loadReplay(matchId: string): Promise<ReplayBundle | null>;
  replaySeatViews(
    matchId: string,
    seatId: string,
  ): Promise<{ views: GameView[] | null; error?: string }>;
  /** Public-only unless the user explicitly selects another perspective. */
  exportTranscript(matchId: string, perspective?: TranscriptPerspective): Promise<ExportResult>;
  exportBackup(): Promise<ExportResult>;
  importBackup(): Promise<BackupImportResult>;
  leaderboard(): Promise<LeaderboardRow[]>;
  arenaStart(config: ArenaConfig): Promise<{ ok: boolean; error?: string }>;
  arenaPause(paused: boolean): Promise<void>;
  arenaCancel(): Promise<void>;
  arenaState(): Promise<ArenaProgress>;
  onArena(handler: (progress: ArenaProgress) => void): () => void;
  listVoices(): Promise<VoicePreset[]>;
  speak(text: string, seatId: string, voice?: number): Promise<{ audio?: string; error?: string }>;
  transcribe(wavBase64: string): Promise<{ text?: string; error?: string }>;
  openDataFolder(): Promise<void>;
}

export interface AppStatus {
  version: string;
  hasKey: boolean;
  /** False when a key is stored but OpenRouter rejects it. */
  keyValid: boolean;
  keyInfo: KeyInfo | null;
  storage: 'keyring' | 'file';
}

export interface KeyResult {
  ok: boolean;
  error?: string;
  keyInfo?: KeyInfo;
}

export interface ModelCatalogResult {
  models: ModelInfo[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface VoicePreset {
  id: string;
  name: string;
  /** Speaker index in the Piper model (0–903). */
  speaker: number;
  lengthScale: number;
}

export interface SeatPreview {
  seatId: string;
  /** Partial table talk; an empty string means the seat stopped composing. */
  text: string;
}

export type ProviderKind = 'openrouter' | 'local';

export interface SeatConfig {
  modelId: string;
  provider?: ProviderKind;
  /** OpenAI-compatible base URL for local seats, e.g. http://127.0.0.1:11434/v1. */
  baseUrl?: string;
  persona?: string;
  /** Piper speaker index; undefined picks a stable voice from the seat id. */
  voice?: number;
  temperature?: number;
  /** Optional per-seat spend cap in USD. */
  budgetUsd?: number;
}

export interface AppConfig {
  humanName: string;
  seats: SeatConfig[];
  /** Default endpoint used when adding a local model seat. */
  localEndpoint: string;
  /** Hard ceiling for a single match, in USD. */
  budgetUsd: number;
  /** Delay between AI actions, higher is faster. */
  speed: number;
  /** Read model messages aloud, each seat with its own voice. */
  voice: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  humanName: 'You',
  seats: [],
  localEndpoint: 'http://127.0.0.1:11434/v1',
  budgetUsd: 2,
  speed: 1,
  voice: true,
};

export interface GameInfo {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;
  capabilities: {
    chat: boolean;
    simultaneousPhases: boolean;
    items: boolean;
    health: boolean;
    solver: boolean;
    uiPanels: string[];
  };
}

export interface StartMatchRequest {
  gameId: string;
  seats: Array<{
    name: string;
    kind: 'human' | 'llm';
    modelId?: string;
    provider?: ProviderKind;
    baseUrl?: string;
    persona?: string;
    voice?: number;
    budgetUsd?: number;
  }>;
  seed?: number;
  budgetUsd: number;
  speed: number;
  /** Ask the game to score decisions against its solver, if it has one. */
  trackOptimality?: boolean;
}

export interface StartMatchResult {
  ok: boolean;
  matchId?: string;
  error?: string;
}

export interface TableSnapshot {
  matchId: string;
  gameId: string;
  gameName: string;
  spectator: boolean;
  status: 'running' | 'paused' | 'finished' | 'aborted';
  view: GameView;
  godView: GameView | null;
  humanSeatId: string | null;
  awaitingHuman: boolean;
  /** Per-seat transport failures, shown as a banner instead of failing silently. */
  seatIssues: SeatIssue[];
  /** Live health for every model seat, including retries and degraded modes. */
  seatHealth: SeatHealth[];
  /** Seats the human has taken over from a model. */
  takenOverSeats: string[];
  /** ms left in the current phase's deadline, or null when it has none. */
  timeLeftMs: number | null;
  costUsd: number;
  eventCount: number;
  paused: boolean;
  speed: number;
  budgetUsd: number;
}

export interface SeatIssue {
  seatId: string;
  name: string;
  message: string;
  count: number;
  kind?: ProviderErrorKind;
}

export interface SeatHealth {
  seatId: string;
  name: string;
  modelId?: string;
  status: 'idle' | 'ok' | 'degraded' | 'error';
  calls: number;
  errors: number;
  retries: number;
  costUsd: number;
  avgLatencyMs: number;
  message?: string;
  kind?: ProviderErrorKind;
}

export interface SeatTestRequest {
  name: string;
  modelId: string;
  provider?: ProviderKind;
  baseUrl?: string;
}

export interface SeatTestResult {
  name: string;
  modelId: string;
  ok: boolean;
  kind?: ProviderErrorKind;
  message?: string;
  latencyMs: number;
  costUsd: number;
  structured: boolean;
}

export interface LocalModelsResult {
  models: ModelInfo[];
  error?: string;
}

export interface SeatSummary {
  seatId: string;
  name: string;
  kind: string;
  modelId?: string;
  role?: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  invalidActions: number;
  errors?: number;
  metrics?: Record<string, number>;
}

export interface ResumableMatch {
  matchId: string;
  gameId: string;
  gameName: string;
  eventCount: number;
  updatedAt: number;
  seats: Array<{ name: string; modelId?: string }>;
}

export interface MatchSummary {
  matchId: string;
  gameId: string;
  gameName: string;
  startedAt: number;
  durationMs: number;
  winners: string[];
  winnerNames: string[];
  seats: SeatSummary[];
  totalCostUsd: number;
  eventCount: number;
  metrics: Record<string, number>;
  aborted?: boolean;
  /** False for local-only matches where no debrief model is configured. */
  debriefExpected?: boolean;
}

export interface ArenaSeatConfig {
  modelId: string;
  name: string;
}

export interface ArenaConfig {
  gameId: string;
  seats: ArenaSeatConfig[];
  matches: number;
  seedBase: number;
  budgetPerMatch: number;
  totalBudgetUsd: number;
}

export interface ArenaResult {
  matchId: string;
  gameName: string;
  winnerNames: string[];
  costUsd: number;
  eventCount: number;
  seats: Array<{ name: string; modelId?: string; role?: string }>;
}

export interface ArenaProgress {
  running: boolean;
  paused: boolean;
  index: number;
  total: number;
  currentGame?: string;
  currentSeats?: string[];
  currentPhase?: string;
  costUsd: number;
  totalBudgetUsd: number;
  results: ArenaResult[];
  error?: string;
  finishedAt?: number;
}

export interface Debrief {
  matchId: string;
  text: string;
  model: string;
  costUsd: number;
}

export type TranscriptPerspective =
  | { mode: 'public' }
  | { mode: 'seat'; seatId: string }
  | { mode: 'omniscient' };

export const REPLAY_FORMAT_VERSION = 2;
export const BACKUP_FORMAT_VERSION = 1;

export interface ReplayBundle {
  /** Storage format; bumped when a field's meaning changes. */
  formatVersion?: number;
  summary: MatchSummary;
  /** Setup options used for the match (discussion rounds, solver tracking). */
  options?: Record<string, unknown>;
  debrief?: { text: string; model: string; costUsd: number };
  seats: Seat[];
  seed: number;
  events: MatchEvent[];
  views: GameView[];
  godViews: GameView[];
}

export interface LeaderboardRow {
  modelId: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  avgCostUsd: number;
  metrics: Record<string, number>;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface BackupBundle {
  format: 'gametable-backup';
  formatVersion: number;
  appVersion: string;
  exportedAt: number;
  config: AppConfig;
  results: MatchRecord[];
  matches: ReplayBundle[];
}

export interface BackupImportResult {
  ok: boolean;
  error?: string;
  importedMatches?: number;
  skippedMatches?: number;
  importedResults?: number;
  legacyMatches?: number;
  configRestored?: boolean;
}
