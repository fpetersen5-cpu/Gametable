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
  onTable(handler: (snapshot: TableSnapshot) => void): () => void;
  onFinished(handler: (summary: MatchSummary) => void): () => void;
  onMatchError(handler: (message: string) => void): () => void;

  listMatches(): Promise<MatchSummary[]>;
  loadReplay(matchId: string): Promise<ReplayBundle | null>;
  exportTranscript(matchId: string): Promise<ExportResult>;
  leaderboard(): Promise<LeaderboardRow[]>;
  openDataFolder(): Promise<void>;
}

export interface AppStatus {
  version: string;
  hasKey: boolean;
  keyInfo: KeyInfo | null;
  storage: 'portal' | 'file';
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
}

export interface AppConfig {
  humanName: string;
  seats: SeatConfig[];
  /** Hard ceiling for a single match, in USD. */
  budgetUsd: number;
  /** Delay between AI actions, higher is faster. */
  speed: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  humanName: 'You',
  seats: [],
  budgetUsd: 2,
  speed: 1,
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
  seats: Array<{ name: string; kind: 'human' | 'llm'; modelId?: string; persona?: string }>;
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
  costUsd: number;
  eventCount: number;
  paused: boolean;
  speed: number;
  budgetUsd: number;
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
  metrics?: Record<string, number>;
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

export interface ReplayBundle {
  summary: MatchSummary;
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
