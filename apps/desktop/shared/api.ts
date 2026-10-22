import type { KeyInfo, ModelInfo } from '@gametable/agent';
import type { ChatLine, GameAction, GameView, MatchEvent, Phase, Seat, SeatInfo } from '@gametable/engine';

export type { KeyInfo, ModelInfo, ChatLine, GameAction, GameView, MatchEvent, Phase, Seat, SeatInfo };

/** The renderer's entire surface. No key, no prompts, no game state beyond views. */
export interface DesktopApi {
  status(): Promise<AppStatus>;
  setKey(key: string): Promise<KeyResult>;
  clearKey(): Promise<void>;
  listModels(refresh?: boolean): Promise<ModelCatalogResult>;
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
  onFinished(handler: (summary: MatchSummary) => void): () => void;
  onMatchError(handler: (message: string) => void): () => void;
  onDebrief(handler: (debrief: Debrief) => void): () => void;

  listMatches(): Promise<MatchSummary[]>;
  listResumable(): Promise<ResumableMatch[]>;
  resumeMatch(matchId: string): Promise<StartMatchResult>;
  loadReplay(matchId: string): Promise<ReplayBundle | null>;
  replaySeatViews(matchId: string, seatId: string): Promise<GameView[] | null>;
  exportTranscript(matchId: string): Promise<ExportResult>;
  leaderboard(): Promise<LeaderboardRow[]>;
  arenaStart(config: ArenaConfig): Promise<{ ok: boolean; error?: string }>;
  arenaPause(paused: boolean): Promise<void>;
  arenaCancel(): Promise<void>;
  arenaState(): Promise<ArenaProgress>;
  onArena(handler: (progress: ArenaProgress) => void): () => void;
  speak(text: string, seatId: string): Promise<{ audio?: string; error?: string }>;
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

export interface SeatConfig {
  modelId: string;
  persona?: string;
  temperature?: number;
  /** Optional per-seat spend cap in USD. */
  budgetUsd?: number;
}

export interface AppConfig {
  humanName: string;
  seats: SeatConfig[];
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
    persona?: string;
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

export interface ReplayBundle {
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
