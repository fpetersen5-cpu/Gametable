import type { GameAction, SeatId } from './types.js';

/** Append-only record of what happened. `seed + events` reproduces a match. */
export interface MatchEvent {
  seq: number;
  phaseId: string;
  round?: number;
  seatId: SeatId;
  action: GameAction;
  /** Wall-clock metadata; excluded from replay determinism checks. */
  at?: number;
}
