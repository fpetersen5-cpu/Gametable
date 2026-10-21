/**
 * Core game-definition contract.
 *
 * Frozen at v1.0 (M2c). Additions must be optional and additive; breaking
 * changes require a major version bump of ENGINE_VERSION and every shipped
 * game must move with it.
 *
 * The engine is a referee: it owns all state, decides what each seat is
 * allowed to see (`view`) and allowed to do (`legalActions` via the view),
 * and validates every action (`apply`). Game modules never call out to the
 * network, never read the clock, and never touch the filesystem.
 */

export type SeatId = string;

export type SeatKind = 'human' | 'llm' | 'bot';

export interface Seat {
  id: SeatId;
  name: string;
  kind: SeatKind;
  /** OpenRouter model id, for LLM seats. */
  modelId?: string;
  /** Free-form play-style instruction ("paranoid analyst", "chaos gremlin"). */
  persona?: string;
}

export interface GameAction {
  type: string;
  [key: string]: unknown;
}

export interface Phase {
  id: string;
  label: string;
  kind: 'sequential' | 'simultaneous';
  /** Seat that must act now (sequential phases). */
  actor: SeatId | null;
  /** Seats that must act (all actors in simultaneous phases). */
  actors: SeatId[];
  /** Day/turn counter, when the game has one. */
  round?: number;
}

export interface ChatLine {
  id: string;
  seatId: SeatId;
  /** 'public', or a private channel such as 'mafia'. */
  channel: string;
  text: string;
  /** Seat this line was addressed to, if any. */
  to?: SeatId;
  phaseId: string;
  round: number;
}

export interface SeatInfo {
  id: SeatId;
  name: string;
  kind: SeatKind;
  modelId?: string;
  /** Absent when the game has no elimination concept. */
  alive?: boolean;
}

/**
 * Everything a seat knows. This is the only thing the human UI receives for
 * the human seat and the only thing an LLM prompt is built from.
 */
export interface GameView {
  gameId: string;
  seatId: SeatId;
  phase: Phase;
  seats: SeatInfo[];
  /** Game-specific, already filtered for this seat. */
  data: unknown;
  /** Rules + role card for this seat, as the agent prompt builder sees it. */
  briefing: string;
  chat: ChatLine[];
  legalActions: GameAction[];
  terminal: boolean;
  winners: SeatId[];
}

export interface Scoring {
  winners: SeatId[];
  scores: Record<SeatId, number>;
}

export interface SetupContext {
  seed: number;
  seats: Seat[];
  options: Record<string, unknown>;
}

export interface GameCapabilities {
  /** Has a discussion/chat channel that the UI must render. */
  chat: boolean;
  simultaneousPhases: boolean;
  items: boolean;
  health: boolean;
  /** Ships an exact solver whose EV can be used for scoring models. */
  solver: boolean;
  /** Named UI panels this game needs, e.g. ['item-belt', 'health-bar']. */
  uiPanels: string[];
}

export interface GameDef<S = unknown> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly minSeats: number;
  readonly maxSeats: number;
  readonly capabilities: GameCapabilities;

  setup(ctx: SetupContext): S;
  phase(state: S): Phase;
  /** Projection for one seat. Must be pure and must reject unknown seats. */
  view(state: S, seatId: SeatId): GameView;
  /**
   * Omniscient projection for spectators and replays. Never sent to a player.
   * Optional: the UI falls back to the first seat's view when absent.
   */
  godView?(state: S): GameView;
  /** Pure transition. Throws `IllegalAction` for anything not in the view. */
  apply(state: S, seatId: SeatId, action: GameAction): S;
  terminal(state: S): boolean;
  scoring(state: S): Scoring;
  /** Game-specific numbers for the leaderboard, e.g. { accusations: 12 }. */
  metrics(state: S): Record<string, number>;
  /**
   * Per-seat numbers for the leaderboard, e.g. { evLoss: 0.42 }.
   * Preferred over `metrics` when ranking individual models.
   */
  metricsFor?(state: S, seatId: SeatId): Record<string, number>;
  /** Rules + role card for this seat, used by the agent prompt builder. */
  briefing(state: S, seatId: SeatId): string;
  /**
   * Tokens that must never appear in this seat's view (other players' roles,
   * hidden hands, deck order...). Consumed by the leak checker.
   */
  secrets(state: S, seatId: SeatId): string[];
  /** The seat's role or faction label, for the results record. */
  roleOf?(state: S, seatId: SeatId): string | undefined;
  /**
   * Wall-clock limit for the current phase, in ms, or null for no limit.
   * When it expires the runner applies `timeoutAction` and records it as a
   * normal event, so replays stay exact.
   */
  phaseTimeoutMs?(state: S): number | null;
  /** The action the runner submits when a phase deadline expires. */
  timeoutAction?(state: S): GameAction | null;
}
